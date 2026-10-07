use isahc::prelude::*;
use isahc::{config::RedirectPolicy, Request};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum DownloaderError {
    #[error("RequestError: {0}")]
    Request(#[from] isahc::Error),
    #[error("HttpError: {0}")]
    HttpError(#[from] isahc::http::Error),
    #[error("StdIoError: {0}")]
    StdIoError(#[from] std::io::Error),
    #[error("Failed to parse URL body: {0}")]
    InvalidUrlBody(String),
}

pub struct Downloader;

impl Downloader {
    pub fn download_without_cache_blocking(url: &str) -> Result<String, DownloaderError> {
        let mut response = Request::get(url)
            .header("Content-Type", "application/octet-stream")
            .redirect_policy(RedirectPolicy::Follow)
            .body(())?
            .send()?;
        let bytes = response.bytes()?;
        String::from_utf8(bytes).map_err(|e| DownloaderError::InvalidUrlBody(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    #[tokio::test]
    async fn blocking_download_follows_redirects_inside_a_runtime() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for response in [
                "HTTP/1.1 302 Found\r\nLocation: /layout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nlayout {}",
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        assert_eq!(
            Downloader::download_without_cache_blocking(&format!("http://{address}/redirect"))
                .unwrap(),
            "layout {}"
        );
        server.join().unwrap();
    }
}
