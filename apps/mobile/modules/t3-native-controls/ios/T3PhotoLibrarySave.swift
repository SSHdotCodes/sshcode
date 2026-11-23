import AVFoundation
import ExpoModulesCore
import ImageIO
import Photos
import UIKit
import UniformTypeIdentifiers

/// Adds an image file the app already holds to the photo library. Add-only access never
/// reveals the user's library, so it is the only Photos permission the app asks for.
enum T3PhotoLibrarySave {
  /// Photos stores these as the original bytes; other decodable formats are re-encoded.
  private static let originalTypes: [UTType] = [.jpeg, .png, .heic, .heif, .gif, .tiff]

  static func saveImage(at url: URL) async throws {
    guard url.isFileURL, FileManager.default.isReadableFile(atPath: url.path) else {
      throw exception("ERR_PHOTOS_FILE", "The image is no longer available.")
    }
    let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    guard status == .authorized || status == .limited else {
      throw exception("ERR_PHOTOS_PERMISSION", "SSHCode is not allowed to add images to Photos.")
    }
    // Identify by content: cached downloads may carry a caption instead of a filename.
    guard
      let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      CGImageSourceGetCount(source) > 0,
      let identifier = CGImageSourceGetType(source),
      let type = UTType(identifier as String)
    else {
      throw exception("ERR_PHOTOS_FORMAT", "This image format cannot be saved to Photos.")
    }
    let keepsOriginal = originalTypes.contains { type.conforms(to: $0) }
    let reencoded = keepsOriginal ? nil : UIImage(contentsOfFile: url.path)
    guard keepsOriginal || reencoded != nil else {
      throw exception("ERR_PHOTOS_FORMAT", "This image format cannot be saved to Photos.")
    }
    do {
      try await PHPhotoLibrary.shared().performChanges {
        if let reencoded {
          PHAssetChangeRequest.creationRequestForAsset(from: reencoded)
        } else {
          let options = PHAssetResourceCreationOptions()
          options.uniformTypeIdentifier = type.identifier
          PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: url, options: options)
        }
      }
    } catch {
      throw exception("ERR_PHOTOS_SAVE", error.localizedDescription)
    }
  }

  /// Adds a local video file to the photo library, as the share sheet's "Save Video" would.
  static func saveVideo(at url: URL) async throws {
    guard url.isFileURL, FileManager.default.isReadableFile(atPath: url.path) else {
      throw exception("ERR_PHOTOS_FILE", "The video is no longer available.")
    }
    guard UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(url.path) else {
      throw exception("ERR_PHOTOS_FORMAT", "This video format cannot be saved to Photos.")
    }
    let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    guard status == .authorized || status == .limited else {
      throw exception("ERR_PHOTOS_PERMISSION", "SSHCode is not allowed to add videos to Photos.")
    }
    let options = PHAssetResourceCreationOptions()
    if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .movie) {
      options.uniformTypeIdentifier = type.identifier
    }
    // Generated videos (ffmpeg, renders) carry no capture date, which reads as 1904 and can
    // file them at the far top of the library; date those now so they appear in Recents.
    var creationDate: Date?
    if let item = try? await AVURLAsset(url: url).load(.creationDate),
      let date = try? await item.load(.dateValue), date.timeIntervalSince1970 > 0
    {
      creationDate = date
    }
    do {
      try await PHPhotoLibrary.shared().performChanges {
        let request = PHAssetCreationRequest.forAsset()
        request.addResource(with: .video, fileURL: url, options: options)
        request.creationDate = creationDate ?? Date()
      }
    } catch {
      let nsError = error as NSError
      throw exception(
        "ERR_PHOTOS_SAVE",
        "\(nsError.localizedDescription) (\(nsError.domain) \(nsError.code))"
      )
    }
  }

  private static func exception(_ code: String, _ description: String) -> Exception {
    Exception(name: code, description: description, code: code)
  }
}
