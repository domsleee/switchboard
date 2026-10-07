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

async fn computer_name(configured: &str) -> String {
    // Keep the name the user already chose in the terminal host configuration.
    if name(configured.trim()).is_ok() {
        return configured.trim().to_owned();
    }
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
        "computer_name":computer_name(&mesh.local_engine.config.name).await,
        "name":"My computers",
        "address":if addresses.len()==1 { addresses.first().cloned() } else { None },
        "requires_choice":addresses.len()>1,
        "addresses":addresses,
    })))
}

/// Start receiving requests without requiring a visit to the Computers page.
/// Multiple networks still require an explicit local selection.
pub(in crate::switchboard_relay) fn start(state: RelayState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let Some(mesh) = &state.mesh else {
            return;
        };
        let setup = async {
            if mesh.database.lock().await.local.is_some() {
                return mesh.start_gateway().await;
            }
            let suggested = defaults(State(state.clone()))
                .await
                .map_err(|_| anyhow::anyhow!("No local pairing address"))?
                .0;
            let Some(address) = suggested["address"].as_str() else {
                return Ok(());
            };
            mesh.configure(
                suggested["computer_name"]
                    .as_str()
                    .unwrap_or("This computer")
                    .into(),
                address.into(),
            )
            .await
        };
        if setup.await.is_err() {
            log::warn!("Pairing setup unavailable; choose a connection in Computers");
        }
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if mesh.database.lock().await.joining.is_some() {
                let _ = mesh.resume().await;
            }
            mesh.synchronize().await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn configured_computer_name_takes_precedence_over_system_hostname() {
        assert_eq!(computer_name(" Windows ").await, "Windows");
    }
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
