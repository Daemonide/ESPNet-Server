use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::Local;
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::{TcpListener, UdpSocket},
    sync::{broadcast, Mutex},
    time::{sleep, Duration},
};
use tower_http::cors::{Any, CorsLayer};

const STORAGE_FILE: &str = "persistence.json";
const ESP_LOCAL_PORT: u16 = 8889;
const SERVER_UDP_PORT: u16 = 8888;
const DISCOVERY_BROADCAST_PORT: u16 = 8889;

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ESPDevice {
    mac: String,
    ip: String,
    last_seen: i64,
    is_online: bool,
    identifier: Option<String>,
    team: Option<String>,
    tagged_out: bool,
    first_seen: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct GameState {
    teams: HashMap<String, Vec<String>>,
    tagged_out: HashMap<String, bool>,
    winners: Option<String>,
}

struct AppState {
    devices: RwLock<HashMap<String, ESPDevice>>,
    tx: broadcast::Sender<serde_json::Value>,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn load_persistence() -> HashMap<String, ESPDevice> {
    if let Ok(data) = fs::read_to_string(STORAGE_FILE) {
        if let Ok(mut map) = serde_json::from_str::<HashMap<String, ESPDevice>>(&data) {
            println!(
                "[{}] STORAGE: Persistence restored ({} devices)",
                Local::now().format("%H:%M:%S"),
                map.len()
            );
            for dev in map.values_mut() {
                dev.is_online = false;
            }
            return map;
        }
    }
    HashMap::new()
}

fn save_persistence(devices: &HashMap<String, ESPDevice>) {
    if let Ok(json) = serde_json::to_string_pretty(devices) {
        if let Err(e) = fs::write(STORAGE_FILE, json) {
            eprintln!(
                "[{}] STORAGE: Failed to save persistence: {}",
                Local::now().format("%H:%M:%S"),
                e
            );
        }
    }
}

fn build_game_state(dev_map: &HashMap<String, ESPDevice>) -> GameState {
    let mut teams: HashMap<String, Vec<String>> = HashMap::new();
    let mut tagged_out: HashMap<String, bool> = HashMap::new();

    for (mac, dev) in dev_map.iter() {
        if let Some(team) = &dev.team {
            teams.entry(team.clone()).or_default().push(mac.clone());
        }
        if dev.tagged_out {
            tagged_out.insert(mac.clone(), true);
        }
    }

    GameState {
        teams,
        tagged_out,
        winners: None,
    }
}

fn broadcast_state(state: &Arc<AppState>) {
    let payload = {
        let dev_map = state.devices.read().unwrap();
        let game_state = build_game_state(&dev_map);

        serde_json::json!({
            "devices": dev_map.values().cloned().collect::<Vec<ESPDevice>>(),
            "game": game_state
        })
    };

    let receivers = state.tx.receiver_count();
    if receivers > 0 {
        let _ = state.tx.send(payload);
    }
}

fn check_win_condition(devices: &HashMap<String, ESPDevice>, tx: &broadcast::Sender<serde_json::Value>) {
    let mut red_alive = 0;
    let mut red_total = 0;
    let mut blue_alive = 0;
    let mut blue_total = 0;

    for dev in devices.values() {
        if let Some(team) = &dev.team {
            match team.as_str() {
                "red" => {
                    red_total += 1;
                    if !dev.tagged_out {
                        red_alive += 1;
                    }
                }
                "blue" => {
                    blue_total += 1;
                    if !dev.tagged_out {
                        blue_alive += 1;
                    }
                }
                _ => {}
            }
        }
    }

    if red_total > 0 && red_alive == 0 {
        println!(
            "[{}] VICTORY: Team Blue wins!",
            Local::now().format("%H:%M:%S")
        );
        let _ = tx.send(serde_json::json!({
            "type": "victory",
            "winner": "blue",
            "message": "Team Blue wins! All red players eliminated!"
        }));
    } else if blue_total > 0 && blue_alive == 0 {
        println!(
            "[{}] VICTORY: Team Red wins!",
            Local::now().format("%H:%M:%S")
        );
        let _ = tx.send(serde_json::json!({
            "type": "victory",
            "winner": "red",
            "message": "Team Red wins! All blue players eliminated!"
        }));
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (tx, _rx) = broadcast::channel::<serde_json::Value>(128);

    let shared_state = Arc::new(AppState {
        devices: RwLock::new(load_persistence()),
        tx,
    });

    println!("\n==================================================");
    println!("ESPNet LASER TAG SERVER v2.0");
    println!("Press 'b' for Table | 'c' to Clear Logs");
    println!("==================================================\n");

    // TERMINAL COMMANDS
    let term_state = shared_state.clone();
    tokio::spawn(async move {
        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin).lines();

        while let Ok(Some(line)) = reader.next_line().await {
            let cmd = line.trim().to_lowercase();
            if cmd == "b" {
                let dev_map = term_state.devices.read().unwrap();
                let now = now_unix();

                println!(
                    "\n--- LASER TAG ARENA ({}) ---",
                    Local::now().format("%H:%M:%S")
                );
                println!(
                    "{:<18} | {:<8} | {:<6} | {:<12} | {}",
                    "IDENT", "TEAM", "TAGGED", "LAST SEEN", "STATUS"
                );
                println!("{}", "-".repeat(75));

                for dev in dev_map.values() {
                    let diff = now - dev.last_seen;
                    let status = if dev.is_online && diff < 30 {
                        "ONLINE"
                    } else {
                        "OFFLINE"
                    };
                    let team = dev.team.as_deref().unwrap_or("---");
                    let tagged = if dev.tagged_out { "YES" } else { "NO" };
                    let ident = dev.identifier.as_deref().unwrap_or("---");
                    println!(
                        "{:<18} | {:<8} | {:<6} | {:>8}s ago | {}",
                        ident, team, tagged, diff, status
                    );
                }

                println!("--------------------------------------------------\n");
            } else if cmd == "c" {
                print!("{}[2J{}[1;1H", 27 as char, 27 as char);
            }
        }
    });

    // DISCOVERY BROADCAST
    tokio::spawn(async move {
        println!(
            "[{}] DISCOVERY: Starting broadcast service",
            Local::now().format("%H:%M:%S")
        );

        let broadcast_addr: SocketAddr = format!("255.255.255.255:{}", DISCOVERY_BROADCAST_PORT)
            .parse()
            .unwrap();

        loop {
            if let Ok(socket) = UdpSocket::bind("0.0.0.0:0").await {
                let _ = socket.set_broadcast(true);
                let _ = socket.send_to(b"ESPNet-Server-Online", broadcast_addr).await;
            }
            sleep(Duration::from_secs(2)).await;
        }
    });

    // HEARTBEATS + DISCOVERY + TAG EVENTS
    let udp_state = shared_state.clone();
    tokio::spawn(async move {
        let socket = UdpSocket::bind(format!("0.0.0.0:{}", SERVER_UDP_PORT))
            .await
            .expect("Failed to bind UDP socket");

        println!(
            "[{}] UDP: Listening on port {}",
            Local::now().format("%H:%M:%S"),
            SERVER_UDP_PORT
        );

        let mut buf = [0u8; 1024];

        loop {
            match socket.recv_from(&mut buf).await {
                Ok((amt, src)) => {
                    let msg = String::from_utf8_lossy(&buf[..amt]).trim().to_string();
                    let esp_addr = SocketAddr::new(src.ip(), ESP_LOCAL_PORT);

                    if msg == "DISCOVER_SERVER" {
                        println!(
                            "[{}] DISCOVERY: Received from {}, responding to {}...",
                            Local::now().format("%H:%M:%S"),
                            src,
                            esp_addr
                        );

                        match socket.send_to(b"ESPNet-Server-Online", esp_addr).await {
                            Ok(bytes) => println!(
                                "[{}] DISCOVERY: Sent {} bytes to {}",
                                Local::now().format("%H:%M:%S"),
                                bytes,
                                esp_addr
                            ),
                            Err(e) => eprintln!(
                                "[{}] DISCOVERY: Failed to send to {}: {}",
                                Local::now().format("%H:%M:%S"),
                                esp_addr,
                                e
                            ),
                        }
                        continue;
                    }

                    if msg.starts_with("HEARTBEAT") {
                        let parts: Vec<&str> = msg.split('|').collect();
                        if parts.len() == 3 {
                            let mac = parts[1].to_string();
                            let ip = parts[2].to_string();
                            let now = now_unix();

                            println!(
                                "[{}] HEARTBEAT: Received from {} at {}",
                                Local::now().format("%H:%M:%S"),
                                mac,
                                ip
                            );

                            if let Ok(_) = socket.send_to(b"HEARTBEAT_ACK", esp_addr).await {
                                println!(
                                    "[{}] HEARTBEAT: Sent ACK to {}",
                                    Local::now().format("%H:%M:%S"),
                                    esp_addr
                                );
                            }

                            let mut dev_map = udp_state.devices.write().unwrap();

                            if let Some(device) = dev_map.get_mut(&mac) {
                                device.ip = ip;
                                device.last_seen = now;
                                device.is_online = true;
                            } else {
                                let device = ESPDevice {
                                    mac: mac.clone(),
                                    ip,
                                    last_seen: now,
                                    is_online: true,
                                    identifier: None,
                                    team: None,
                                    tagged_out: false,
                                    first_seen: now,
                                };
                                dev_map.insert(mac.clone(), device);
                                println!(
                                    "[{}] HEARTBEAT: New device registered: {}",
                                    Local::now().format("%H:%M:%S"),
                                    mac
                                );
                            }

                            save_persistence(&dev_map);
                            drop(dev_map);
                            broadcast_state(&udp_state);
                        }
                        continue;
                    }

                    if msg.starts_with("EVENT|TAG") {
                        let parts: Vec<&str> = msg.split('|').collect();
                        if parts.len() == 3 {
                            let mac = parts[2].to_string();

                            let mut dev_map = udp_state.devices.write().unwrap();
                            if let Some(dev) = dev_map.get_mut(&mac) {
                                println!(
                                    "[{}] TAG EVENT: {} was tagged!",
                                    Local::now().format("%H:%M:%S"),
                                    mac
                                );
                                dev.tagged_out = true;
                                dev.last_seen = now_unix();
                                save_persistence(&dev_map);
                                check_win_condition(&dev_map, &udp_state.tx);
                            }
                            drop(dev_map);
                            broadcast_state(&udp_state);
                        }
                        continue;
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[{}] UDP Error: {}",
                        Local::now().format("%H:%M:%S"),
                        e
                    );
                }
            }

            buf.iter_mut().for_each(|b| *b = 0);
        }
    });

    // PERIODIC ONLINE STATUS CHECK
    let cleanup_state = shared_state.clone();
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(5)).await;

            let mut dev_map = cleanup_state.devices.write().unwrap();
            let now = now_unix();
            let mut changed = false;

            for (mac, device) in dev_map.iter_mut() {
                let diff = now - device.last_seen;
                let was_online = device.is_online;

                device.is_online = diff < 15;

                if was_online != device.is_online {
                    changed = true;
                    if !device.is_online {
                        println!(
                            "[{}] DEVICE: {} went offline (no heartbeat for {}s)",
                            Local::now().format("%H:%M:%S"),
                            mac,
                            diff
                        );
                    }
                }
            }

            if changed {
                save_persistence(&dev_map);
                drop(dev_map);
                broadcast_state(&cleanup_state);
            }
        }
    });

    // HTTP + WS
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/devices", get(get_devices))
        .route("/api/status", get(get_status))
        .route("/api/assign/:mac/:id", post(assign_id))
        .route("/api/team/:mac/:team", put(assign_team))
        .route("/api/tag/:mac", post(toggle_tag))
        .route("/api/reset_game", post(reset_game))
        .route("/api/reset_tags", post(reset_tags))
        .route("/api/restart/:mac", post(send_command))
        .route("/api/reset_wifi/:mac", post(send_command))
        .route("/api/remove/:mac", delete(remove_device))
        .route("/api/clear_all", delete(clear_all))
        .route("/api/refresh", get(refresh_all))
        .route("/api/toggle_tag/:mac", post(toggle_tag))
        .route("/api/device/:mac", delete(delete_device))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(shared_state.clone());

    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    println!(
        "[{}] HTTP: Server active on http://localhost:8080",
        Local::now().format("%H:%M:%S")
    );

    axum::serve(listener, app).await?;
    Ok(())
}

async fn get_devices(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let dev_map = state.devices.read().unwrap();
    let game_state = build_game_state(&dev_map);

    Json(serde_json::json!({
        "devices": dev_map.values().cloned().collect::<Vec<ESPDevice>>(),
        "game": game_state
    }))
}

async fn delete_device(Path(mac): Path<String>, State(state): State<Arc<AppState>>) -> Response {
    {
        let mut dev_map = state.devices.write().unwrap();
        dev_map.remove(&mac);
        save_persistence(&dev_map);
    }
    
    broadcast_state(&state);
    (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response()
}


async fn get_status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let dev_map = state.devices.read().unwrap();
    let now = now_unix();

    let mut online = 0;
    let mut late = 0;
    let mut offline = 0;

    for dev in dev_map.values() {
        let diff = now - dev.last_seen;
        if dev.is_online && diff < 6 {
            online += 1;
        } else if dev.is_online && diff < 15 {
            late += 1;
        } else {
            offline += 1;
        }
    }

    Json(serde_json::json!({
        "server_time": now,
        "total_devices": dev_map.len(),
        "online_devices": online,
        "late_devices": late,
        "offline_devices": offline,
        "websocket_clients": state.tx.receiver_count(),
        "status": "running"
    }))
}

// *** FIX: Return proper JSON response ***
async fn assign_id(
    Path((mac, id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Response {
    println!(
        "[{}] API: Assigning ID {} to device {}",
        Local::now().format("%H:%M:%S"),
        id,
        mac
    );

    let mut dev_map = state.devices.write().unwrap();
    if let Some(dev) = dev_map.get_mut(&mac) {
        dev.identifier = if id.is_empty() || id == "None" {
            None
        } else {
            Some(id.to_uppercase())
        };
        save_persistence(&dev_map);
        drop(dev_map);
        broadcast_state(&state);
        return (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response();
    }
    (StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "Device not found"}))).into_response()
}

// *** FIX: Return proper JSON response ***
async fn assign_team(
    Path((mac, team)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> Response {
    println!(
        "[{}] API: Assigning team {} to device {}",
        Local::now().format("%H:%M:%S"),
        team,
        mac
    );

    let mut dev_map = state.devices.write().unwrap();
    if let Some(dev) = dev_map.get_mut(&mac) {
        if team == "none" || team == "lobby" || team.is_empty() {
            dev.team = None;
        } else {
            dev.team = Some(team);
        }
        save_persistence(&dev_map);
        drop(dev_map);
        broadcast_state(&state);
        return (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response();
    }
    (StatusCode::NOT_FOUND, Json(serde_json::json!({"success": false, "error": "Device not found"}))).into_response()
}

async fn toggle_tag(Path(mac): Path<String>, State(state): State<Arc<AppState>>) -> Response {
    {
        let mut dev_map = state.devices.write().unwrap();
        if let Some(dev) = dev_map.get_mut(&mac) {
            dev.tagged_out = !dev.tagged_out;
            save_persistence(&dev_map);
        }
    }
    
    // Check win condition after manual tag
    check_win_condition(&state.devices.read().unwrap(), &state.tx);
    
    broadcast_state(&state);
    (StatusCode::OK, Json(serde_json::json!({"success": true}))).into_response()
}



async fn reset_game(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mut dev_map = state.devices.write().unwrap();
    for dev in dev_map.values_mut() {
        dev.team = None;
        dev.tagged_out = false;
    }
    save_persistence(&dev_map);
    drop(dev_map);
    broadcast_state(&state);
    Json(serde_json::json!({"success": true}))
}

async fn reset_tags(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mut dev_map = state.devices.write().unwrap();
    for dev in dev_map.values_mut() {
        dev.tagged_out = false;
    }
    save_persistence(&dev_map);
    drop(dev_map);
    broadcast_state(&state);
    Json(serde_json::json!({"success": true}))
}

async fn send_command(
    State(state): State<Arc<AppState>>,
    Path(mac): Path<String>,
    uri: axum::http::Uri,
) -> Json<serde_json::Value> {
    let target_ip = {
        let dev_map = state.devices.read().unwrap();
        dev_map.get(&mac).map(|d| d.ip.clone())
    };

    if let Some(ip) = target_ip {
        let cmd = if uri.path().contains("restart") {
            "RESTART"
        } else {
            "WIFI_RESET"
        };

        if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
            let target = format!("{}:{}", ip, ESP_LOCAL_PORT);
            match sock.send_to(cmd.as_bytes(), &target) {
                Ok(_) => return Json(serde_json::json!({"success": true})),
                Err(_) => return Json(serde_json::json!({"success": false})),
            }
        }
    }

    Json(serde_json::json!({"success": false}))
}

async fn remove_device(Path(mac): Path<String>, State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mut dev_map = state.devices.write().unwrap();
    let removed = dev_map.remove(&mac).is_some();
    if removed {
        save_persistence(&dev_map);
        drop(dev_map);
        broadcast_state(&state);
        return Json(serde_json::json!({"success": true}));
    }
    Json(serde_json::json!({"success": false}))
}

async fn clear_all(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mut dev_map = state.devices.write().unwrap();
    dev_map.clear();
    save_persistence(&dev_map);
    drop(dev_map);
    broadcast_state(&state);
    Json(serde_json::json!({"success": true}))
}

async fn refresh_all(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    broadcast_state(&state);
    Json(serde_json::json!({"success": true}))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl axum::response::IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (sender, mut receiver) = socket.split();
    let sender = Arc::new(Mutex::new(sender));
    let mut rx = state.tx.subscribe();

    let initial_payload = {
        let dev_map = state.devices.read().unwrap();
        let game_state = build_game_state(&dev_map);
        serde_json::json!({
            "type": "initial",
            "devices": dev_map.values().cloned().collect::<Vec<ESPDevice>>(),
            "game": game_state
        })
        .to_string()
    };

    {
        let mut guard = sender.lock().await;
        if guard
            .send(Message::Text(initial_payload.into()))
            .await
            .is_err()
        {
            return;
        }
    }

    let sender_for_ping = Arc::clone(&sender);
    tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                if text == "ping" {
                    let mut guard = sender_for_ping.lock().await;
                    let _ = guard.send(Message::Text("pong".into())).await;
                }
            }
        }
    });

    while let Ok(state_msg) = rx.recv().await {
        let mut guard = sender.lock().await;
        if guard
            .send(Message::Text(state_msg.to_string().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}
