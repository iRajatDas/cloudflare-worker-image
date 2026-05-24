use crate::{actions, encoder, error::AppError};
use actix_web::{http::StatusCode, web};
use bytes::Bytes;
use image::{GenericImageView, ImageBuffer, Rgba};
use log::info;
use photon_rs::PhotonImage;
use serde::Deserialize;

/// Query params for URL-based processing (existing GET flow)
#[derive(Deserialize, Debug)]
pub struct ImageQuery {
    pub url: String,
    pub action: Option<String>,
    pub format: Option<String>,
    pub quality: Option<u8>,
}

/// Query params for upload-based processing (new POST flow)
#[derive(Deserialize, Debug)]
pub struct UploadQuery {
    pub action: Option<String>,
    pub format: Option<String>,
    pub quality: Option<u8>,
}

/// Existing: process image from remote URL
pub async fn process_image(
    query: web::Query<ImageQuery>,
) -> Result<(Vec<u8>, &'static str), AppError> {
    info!(
        "URL processing request: {{ url: {}, action: {:?}, format: {:?}, quality: {:?} }}",
        query.url, query.action, query.format, query.quality
    );

    let image_bytes = fetch_image(&query.url).await?;
    let mut img = decode_to_photon(&image_bytes)?;

    // Apply actions if specified
    if let Some(action_str) = &query.action {
        img = actions::apply_actions(img, action_str, &query.url).await?;
    }

    encode_photon_image(img, query.format.as_deref(), query.quality)
}

/// New: process image from uploaded bytes
pub async fn process_uploaded_image(
    query: web::Query<UploadQuery>,
    body: web::Bytes,
) -> Result<(Vec<u8>, &'static str), AppError> {
    info!(
        "Upload processing request: {{ size: {} bytes, action: {:?}, format: {:?}, quality: {:?} }}",
        body.len(),
        query.action,
        query.format,
        query.quality
    );

    if body.is_empty() {
        return Err(AppError::InvalidActionParam("Empty image body".to_string()));
    }

    let mut img = decode_to_photon(&body)?;

    // Apply actions if specified
    if let Some(action_str) = &query.action {
        img = actions::apply_actions(img, action_str, "upload").await?;
    }

    encode_photon_image(img, query.format.as_deref(), query.quality)
}

// ─── Shared helpers ─────────────────────────────────────────────

/// Decode raw bytes into a PhotonImage
fn decode_to_photon(image_bytes: &[u8]) -> Result<PhotonImage, AppError> {
    let dyn_image = image::load_from_memory(image_bytes)?;
    let (width, height) = dyn_image.dimensions();
    let raw_pixels = dyn_image.to_rgba8().into_raw();
    Ok(PhotonImage::new(raw_pixels, width, height))
}

/// Encode a PhotonImage to the desired output format
fn encode_photon_image(
    img: PhotonImage,
    format: Option<&str>,
    quality: Option<u8>,
) -> Result<(Vec<u8>, &'static str), AppError> {
    let format_str = format.unwrap_or("webp");
    let (output_format, content_type) = encoder::get_image_output_format(format_str);

    let image_buffer = ImageBuffer::<Rgba<u8>, _>::from_raw(
        img.get_width(),
        img.get_height(),
        img.get_raw_pixels(),
    )
    .ok_or(AppError::ImageBufferError)?;

    let final_dyn_image = image::DynamicImage::ImageRgba8(image_buffer);
    let encoded_image = encoder::encode_image(final_dyn_image, output_format, quality)?;

    Ok((encoded_image, content_type))
}

/// Fetch image bytes from a remote URL
async fn fetch_image(url: &str) -> Result<Bytes, AppError> {
    let res = reqwest::get(url).await?;

    if !res.status().is_success() {
        return Err(AppError::FetchStatusError {
            url: url.to_string(),
            status: StatusCode::from_u16(res.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        });
    }

    res.bytes().await.map_err(Into::into)
}
