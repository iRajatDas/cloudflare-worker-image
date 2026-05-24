use actix_web::{web, App, HttpResponse, HttpServer, Responder};
use log::info;
use serde::Serialize;
use std::env;

mod actions;
mod encoder;
mod error;
mod processor;
mod utils;
use processor::{process_image, process_uploaded_image, ImageQuery, UploadQuery};

#[derive(Serialize)]
struct StatusResponse<'a> {
    status: &'a str,
    version: &'a str,
    name: &'a str,
}

async fn status() -> impl Responder {
    HttpResponse::Ok().json(StatusResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        name: env!("CARGO_PKG_NAME"),
    })
}

/// GET / — existing URL-based image processing
async fn apply_photon_effect(
    query: web::Query<ImageQuery>,
) -> Result<HttpResponse, error::AppError> {
    let (buf, content_type) = process_image(query).await?;

    Ok(HttpResponse::Ok()
        .content_type(content_type)
        .append_header(("Cache-Control", "public, max-age=31536000"))
        .body(buf))
}

/// POST /process — direct image upload processing
async fn process_upload(
    query: web::Query<UploadQuery>,
    body: web::Bytes,
) -> Result<HttpResponse, error::AppError> {
    let (buf, content_type) = process_uploaded_image(query, body).await?;

    Ok(HttpResponse::Ok()
        .content_type(content_type)
        .append_header(("Cache-Control", "no-cache"))
        .body(buf))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let port = env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8000);
    let workers = env::var("WORKERS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(2, |n| n.get()));

    let server_addr = format!("0.0.0.0:{}", port);

    info!(
        "{} v{} starting on http://{} with {} worker(s)",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        server_addr,
        workers
    );

    HttpServer::new(|| {
        App::new()
            .route("/status", web::get().to(status))
            .route("/", web::get().to(apply_photon_effect))
            // New: direct upload processing
            // Accept up to 15 MB payloads (image + overhead)
            .app_data(web::PayloadConfig::new(15 * 1024 * 1024))
            .route("/process", web::post().to(process_upload))
    })
    .workers(workers)
    .bind(server_addr)?
    .run()
    .await
}
