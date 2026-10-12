//! Untrusted DNS routing hints. TLS pins and signed membership remain authoritative.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::time::Duration;

const LOOKUP_TIMEOUT: Duration = Duration::from_millis(700);

pub(super) fn local_hostname(name: &str) -> Option<String> {
    let name = name.trim();
    let label = if name.to_ascii_lowercase().ends_with(".local") {
        &name[..name.len() - 6]
    } else {
        name
    };
    if label.is_empty()
        || label.len() > 63
        || label.eq_ignore_ascii_case("localhost")
        || !label.as_bytes().first()?.is_ascii_alphanumeric()
        || !label.as_bytes().last()?.is_ascii_alphanumeric()
        || !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some(format!("{label}.local"))
}

pub(super) fn usable_route_address(address: IpAddr) -> bool {
    !address.is_loopback()
        && !address.is_unspecified()
        && !address.is_multicast()
        && !matches!(address, IpAddr::V4(ip) if ip.is_broadcast())
        && !matches!(address, IpAddr::V6(ip) if ip.to_ipv4_mapped().is_some_and(|v4| !usable_route_address(v4.into())))
}

/// Check interface ownership without sending traffic, including on systems that
/// allow binding an address belonging to another computer.
pub(super) fn is_local_address(address: IpAddr) -> bool {
    if address.is_loopback() {
        return true;
    }
    if !usable_route_address(address) || UdpSocket::bind((address, 0)).is_err() {
        return false;
    }
    let unspecified = match address {
        IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    };
    let Ok(route) = UdpSocket::bind((unspecified, 0)) else {
        return false;
    };
    route.connect((address, 9)).is_ok()
        && route
            .local_addr()
            .is_ok_and(|source| source.ip() == address)
}

pub(super) async fn resolve(name: &str, port: u16) -> Vec<SocketAddr> {
    let Some(hostname) = local_hostname(name) else {
        return Vec::new();
    };
    let Ok(Ok(addresses)) = tokio::time::timeout(
        LOOKUP_TIMEOUT,
        tokio::net::lookup_host((hostname.as_str(), port)),
    )
    .await
    else {
        return Vec::new();
    };
    let mut routes = Vec::new();
    for address in addresses.filter(|address| {
        usable_route_address(address.ip())
            && !matches!(address, SocketAddr::V6(address) if address.ip().is_unicast_link_local() && address.scope_id() == 0)
    }) {
        if !routes.contains(&address) {
            routes.push(address);
        }
        if routes.len() == 8 {
            break;
        }
    }
    routes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computer_names_only_form_single_local_dns_labels() {
        for (name, expected) in [
            ("1WN9PD4", "1WN9PD4.local"),
            ("Doms-MacBook-Pro", "Doms-MacBook-Pro.local"),
            ("Doms-MacBook-Pro.LOCAL", "Doms-MacBook-Pro.local"),
        ] {
            assert_eq!(local_hostname(name).as_deref(), Some(expected));
        }
        for name in [
            "",
            "localhost",
            "LOCALHOST.local",
            "My Mac",
            "a.b",
            "a.local.evil",
            "-a",
            "a-",
            "é",
            "a/b",
            "127.0.0.1",
        ] {
            assert_eq!(local_hostname(name), None, "{name}");
        }
        assert!(local_hostname(&"a".repeat(63)).is_some());
        assert!(local_hostname(&"a".repeat(64)).is_none());
    }

    #[test]
    fn routing_hints_cannot_target_loopback_or_unspecified_addresses() {
        for address in [
            "127.0.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "ff02::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!usable_route_address(address.parse().unwrap()), "{address}");
        }
        for address in ["192.0.2.1", "fd00::1", "::ffff:192.0.2.1"] {
            assert!(usable_route_address(address.parse().unwrap()), "{address}");
        }
    }
}
