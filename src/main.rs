use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State, Path},
    routing::{get, post, delete}, Json, Router,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::{Serialize, Deserialize};
use std::{collections::HashMap, sync::{Arc, RwLock}, time::{SystemTime, UNIX_EPOCH}, fs};
use tokio::net::UdpSocket;
use tokio::sync::broadcast;
use tokio::io::{AsyncBufReadExt, BufReader};
use tower_http::cors::CorsLayer;
use chrono::Local;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ESPDevice {
    mac: String,
    ip: String,
    last_seen: i64,
    is_online: bool,
    identifier: Option<String>,
}

struct AppState {
    devices: RwLock<HashMap<String, ESPDevice>>,
    tx: broadcast::Sender<Vec<ESPDevice>>,
}

const STORAGE_FILE: &str = "persistence.json";

fn load_persistence() -> HashMap<String, ESPDevice> {
    if let Ok(data) = fs::read_to_string(STORAGE_FILE) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, ESPDevice>>(&data) {
            println!("[{}] STORAGE: Persistence restored.", Local::now().format("%H:%M:%S"));
            return map;
        }
    }
    HashMap::new()
}

fn save_persistence(devices: &HashMap<String, ESPDevice>) {
    let offline_only: HashMap<String, ESPDevice> = devices.iter()
        .map(|(k, v)| {
            let mut saved = v.clone();
            saved.is_online = false; 
            (k.clone(), saved)
        }).collect();
    let _ = fs::write(STORAGE_FILE, serde_json::to_string(&offline_only).unwrap());
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (tx, _rx) = broadcast::channel(128);
    let shared_state = Arc::new(AppState {
        devices: RwLock::new(load_persistence()),
        tx,
    });

    println!("\n--------------------------------------------------");
    println!("ESPNet CORE: Press 'b' for Table | 'c' to Clear Logs");
    println!("--------------------------------------------------\n");

    // 1. TERMINAL COMMANDS
    let term_state = shared_state.clone();
    tokio::spawn(async move {
        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let cmd = line.trim().to_lowercase();
            if cmd == "b" {
                let dev_map = term_state.devices.read().unwrap();
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
                println!("\n--- HUB HEALTH CHECK ({}) ---", Local::now().format("%H:%M:%S"));
                println!("{:<18} | {:<15} | {:<12} | {}", "MAC", "IP ADDRESS", "LAST SEEN", "STATUS");
                println!("{}", "-".repeat(70));
                for dev in dev_map.values() {
                    let diff = now - dev.last_seen;
                    let status = if diff < 20 { "ONLINE" } else { "OFFLINE" };
                    println!("{:<18} | {:<15} | {:>8}s ago | {}", dev.mac, dev.ip, diff, status);
                }
                println!("--------------------------------------------------\n");
            } else if cmd == "c" {
                print!("{}[2J{}[1;1H", 27 as char, 27 as char);
            }
        }
    });

    // 2. DISCOVERY (Server Broadcast)
    tokio::spawn(async move {
        let socket = UdpSocket::bind("0.0.0.0:0").await.expect("Failed to bind discovery socket");
        socket.set_broadcast(true).unwrap();
        loop {
            let _ = socket.send_to(b"espnet-server-discovery", "255.255.255.255:8889").await;
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        }
    });

    // 3. HEARTBEATS & ACTIVE DISCOVERY
    let udp_state = shared_state.clone();
    tokio::spawn(async move {
        let socket = UdpSocket::bind("0.0.0.0:8888").await.expect("Failed to bind heartbeat socket");
        let mut buf = [0u8; 1024];
        loop {
            if let Ok((amt, src)) = socket.recv_from(&mut buf).await {
                let msg = String::from_utf8_lossy(&buf[..amt]);
                
                if msg == "DISCOVER_SERVER" {
                    let _ = socket.send_to(b"espnet-server-discovery", src).await;
                    continue;
                }

                if msg.starts_with("HEARTBEAT") {
                    let parts: Vec<&str> = msg.split('|').collect();
                    if parts.len() == 3 {
                        let (mac, ip) = (parts[1].to_string(), parts[2].to_string());
                        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
                        
                        let mut dev_map = udp_state.devices.write().unwrap();
                        let (was_off, existing_id) = if let Some(d) = dev_map.get(&mac) {
                            (!d.is_online, d.identifier.clone())
                        } else {
                            (true, None)
                        };

                        dev_map.insert(mac.clone(), ESPDevice { mac: mac.clone(), ip, last_seen: now, is_online: true, identifier: existing_id });
                        if was_off { println!("[{}] CONNECT: {} is online from {}", Local::now().format("%H:%M:%S"), mac, src); }
                        
                        save_persistence(&dev_map);
                        let _ = udp_state.tx.send(dev_map.values().cloned().collect());
                    }
                }
            }
        }
    });

    // --- FIX: Syntax changed from :mac to {mac} in Axum 0.7 ---
    let app = Router::new()
        .route("/api/devices", get(|State(s): State<Arc<AppState>>| async move { Json(s.devices.read().unwrap().values().cloned().collect::<Vec<_>>()) }))
        .route("/api/assign/{mac}/{id}", post(assign_id))
        .route("/api/restart/{mac}", post(send_command))
        .route("/api/reset_wifi/{mac}", post(send_command))
        .route("/api/clear_all", delete(clear_all))
        .route("/ws", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(shared_state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    println!("[{}] HTTP: Server active on http://localhost:3000", Local::now().format("%H:%M:%S"));
    axum::serve(listener, app).await?;
    Ok(())
}

async fn send_command(State(state): State<Arc<AppState>>, Path(mac): Path<String>, uri: axum::http::Uri) -> Json<bool> {
    let target = { let devices = state.devices.read().unwrap(); devices.get(&mac).map(|d| d.ip.clone()) };
    if let Some(ip) = target {
        let cmd = if uri.path().contains("restart") { "RESTART" } else { "WIFI_RESET" };
        let socket = UdpSocket::bind("0.0.0.0:0").await.unwrap();
        let _ = socket.send_to(cmd.as_bytes(), format!("{}:8889", ip)).await;
        return Json(true);
    }
    Json(false)
}

async fn assign_id(Path((mac, id)): Path<(String, String)>, State(state): State<Arc<AppState>>) -> Json<bool> {
    let mut dev_map = state.devices.write().unwrap();
    if let Some(dev) = dev_map.get_mut(&mac) {
        dev.identifier = Some(id.to_uppercase());
        save_persistence(&dev_map);
        let _ = state.tx.send(dev_map.values().cloned().collect());
        return Json(true);
    }
    Json(false)
}

async fn clear_all(State(state): State<Arc<AppState>>) -> Json<bool> {
    let mut dev_map = state.devices.write().unwrap();
    dev_map.clear();
    save_persistence(&dev_map);
    let _ = state.tx.send(vec![]);
    Json(true)
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl axum::response::IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, _) = socket.split();
    let mut rx = state.tx.subscribe();
    
    let initial = {
        let devices = state.devices.read().unwrap();
        serde_json::to_string(&devices.values().cloned().collect::<Vec<_>>()).unwrap()
    };
    if sender.send(Message::Text(initial.into())).await.is_err() { return; }

    while let Ok(devices) = rx.recv().await {
        if let Ok(json) = serde_json::to_string(&devices) {
            if sender.send(Message::Text(json.into())).await.is_err() { break; }
        }
    }
}