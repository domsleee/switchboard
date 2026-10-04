//! Read-only setup suggestions. No listener, membership or credential is retained.
use super::*;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

fn usable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && ip != Ipv4Addr::BROADCAST
        },
        IpAddr::V6(ip) => {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && (ip.segments()[0] & 0xffc0) != 0xfe80
        },
    }
}

fn routed_address(peer: IpAddr) -> Option<IpAddr> {
    let socket = UdpSocket::bind(if peer.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .ok()?;
    // UDP connect selects a route without transmitting a packet to the peer.
    socket.connect(SocketAddr::new(peer, 9)).ok()?;
    let local = socket.local_addr().ok()?.ip();
    usable(local).then_some(local)
}

async fn computer_name() -> String {
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            if name(value.trim()).is_ok() {
                return value.trim().to_owned();
            }
        }
    }
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("hostname")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    if let Ok(Ok(output)) = result {
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout);
            let value = value.trim().trim_end_matches(".local");
            if name(value).is_ok() {
                return value.to_owned();
            }
        }
    }
    "This computer".into()
}

pub(super) async fn defaults(State(state): State<RelayState>) -> Result<Json<Value>, Error> {
    let mesh = state.mesh.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Start this computer's terminal engine before pairing.",
    ))?;
    let current = mesh.status().await;
    if current["configured"] == true {
        return Ok(Json(
            json!({"computer_name":current["computer"]["name"], "address":current["computer"]["address"], "name":current["mesh"].as_str().unwrap_or("My computers"), "addresses":[], "requires_choice":false}),
        ));
    }
    let mut addresses = Vec::new();
    // Existing peers also reveal private/VPN routes that differ from the default.
    let peers = state
        .all_hosts()
        .into_iter()
        .filter_map(|host| {
            host.origin
                .host_str()?
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .ok()
        })
        .filter(|ip| usable(*ip));
    for peer in peers.chain([IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))]) {
        if let Some(ip) = routed_address(peer) {
            if !addresses.contains(&ip) {
                addresses.push(ip);
            }
        }
    }
    let addresses: Vec<String> = addresses
        .into_iter()
        .map(|ip| format!("https://{}", SocketAddr::new(ip, 8082)))
        .collect();
    Ok(Json(json!({
        "computer_name":computer_name().await,
        "name":"My computers",
        "address":if addresses.len()==1 { addresses.first().cloned() } else { None },
        "requires_choice":addresses.len()>1,
        "addresses":addresses,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsuitable_addresses_are_not_suggested() {
        for ip in [
            "127.0.0.1",
            "0.0.0.0",
            "169.254.1.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "ff02::1",
        ] {
            assert!(!usable(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["172.20.10.10", "100.64.1.2", "fd00::1"] {
            assert!(usable(ip.parse().unwrap()), "{ip}");
        }
    }
}
