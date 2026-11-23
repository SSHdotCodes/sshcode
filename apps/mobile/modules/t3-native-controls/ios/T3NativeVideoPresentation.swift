import AVKit
import UniformTypeIdentifiers
import UIKit

final class T3NativeVideoPresentation: NSObject, AVPlayerViewControllerDelegate,
  UIAdaptivePresentationControllerDelegate {
  let identifier: String
  private let controller = AVPlayerViewController()
  private let completion: (Error?) -> Void
  private var itemObservation: NSKeyValueObservation?
  private var backgroundObserver: NSObjectProtocol?
  private var playbackError: Error?
  private var presented = false
  private var dismissRequested = false
  private var finished = false
  private var completionDelivered = false
  private struct AudioSessionConfiguration {
    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions

    init(_ session: AVAudioSession) {
      category = session.category
      mode = session.mode
      options = session.categoryOptions
    }
  }
  private var previousAudioSession: AudioSessionConfiguration?
  private weak var fullScreenController: UIViewController?
  private var embedded = false
  private let sourceURL: URL
  private let title: String
  private var actionsButton: UIButton?
  /// A remote video downloaded once for Save and Share, removed when the player closes.
  private var downloadedFile: URL?
  private var actionTask: Task<Void, Never>?
  private var shareActive = false

  init(identifier: String, url: URL, title: String, completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.completion = completion
    sourceURL = url
    self.title = title
    super.init()

    let item = AVPlayerItem(url: url)
    let metadata = AVMutableMetadataItem()
    metadata.identifier = .commonIdentifierTitle
    metadata.value = title as NSString
    item.externalMetadata = [metadata]
    controller.player = AVPlayer(playerItem: item)
    controller.delegate = self
    controller.overrideUserInterfaceStyle = .dark
    controller.allowsPictureInPicturePlayback = false

    itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
      guard item.status == .failed else { return }
      DispatchQueue.main.async {
        guard let self else { return }
        self.playbackError = item.error ?? NSError(
          domain: "T3NativeVideo",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "This video couldn't be played on this device."]
        )
        self.dismiss()
      }
    }
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.controller.player?.pause() }
  }

  func present(from presenter: UIViewController, sources: T3PresentationSources, sourceIdentifier: String) {
    let audioSession = AVAudioSession.sharedInstance()
    previousAudioSession = AudioSessionConfiguration(audioSession)
    do {
      try audioSession.setCategory(.playback, mode: .moviePlayback)
    } catch {
      NSLog("SSHCode video audio session: %@", error.localizedDescription)
    }
    // AVKit exposes programmatic inline-to-full-screen entry through this selector.
    // This is the same guarded entry point used by expo-video's enterFullscreen().
    let enterFullScreen = NSSelectorFromString("enterFullScreenAnimated:completionHandler:")
    if let source = sources.view(for: sourceIdentifier), source.window != nil,
      controller.responds(to: enterFullScreen) {
      // AVKit owns the transition from its inline view to full screen. Using a
      // separate UIKit zoom transition prevents its native Close action from exiting.
      var responder: UIResponder? = source
      while let current = responder, !(current is UIViewController) { responder = current.next }
      let parent = responder as? UIViewController ?? presenter
      embedded = true
      parent.addChild(controller)
      controller.view.frame = source.bounds
      controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      source.addSubview(controller.view)
      controller.didMove(toParent: parent)
      controller.view.layoutIfNeeded()
      controller.perform(enterFullScreen, with: true, with: nil)
      controller.player?.play()
    } else {
      presenter.present(controller, animated: true) { [self] in
        presented = true
        installActionsButton(in: controller.view)
        if dismissRequested {
          dismiss()
        } else if UIApplication.shared.applicationState == .active {
          controller.player?.play()
        }
      }
      controller.presentationController?.delegate = self
    }
  }

  func dismiss() {
    dismissRequested = true
    guard !finished else { return }
    guard presented else {
      if embedded && fullScreenController == nil { finish() }
      return
    }
    (fullScreenController ?? controller).dismiss(animated: true) { [self] in finish() }
  }

  func playerViewController(
    _ playerViewController: AVPlayerViewController,
    willBeginFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
  ) {
    fullScreenController = coordinator.viewController(forKey: .to)
    coordinator.animate(alongsideTransition: nil) { [weak self] context in
      guard let self else { return }
      if context.isCancelled {
        finish()
      } else {
        presented = true
        if let view = fullScreenController?.view { installActionsButton(in: view) }
        if dismissRequested { dismiss() }
      }
    }
  }

  func playerViewController(
    _ playerViewController: AVPlayerViewController,
    willEndFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
  ) {
    dismissRequested = true
    coordinator.animate(alongsideTransition: nil) { [weak self] context in
      if context.isCancelled {
        self?.dismissRequested = false
      } else {
        self?.finish()
      }
    }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish()
  }

  // MARK: Save and share

  /// AVKit takes no custom controls on iPhone, so Save and Share sit opposite its
  /// Close and AirPlay buttons.
  private func installActionsButton(in view: UIView) {
    guard actionsButton == nil else { return }
    var configuration: UIButton.Configuration
    if #available(iOS 26.0, *) {
      configuration = .glass()
    } else {
      configuration = .gray()
      configuration.baseForegroundColor = .white
    }
    configuration.cornerStyle = .capsule
    configuration.image = UIImage(
      systemName: "square.and.arrow.up",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
    )
    let button = UIButton(configuration: configuration)
    button.accessibilityLabel = "Save or share video"
    button.showsMenuAsPrimaryAction = true
    button.menu = UIMenu(children: [
      UIAction(title: "Save to Photos", image: UIImage(systemName: "square.and.arrow.down")) {
        [weak self] _ in self?.saveToPhotos()
      },
      UIAction(title: "Share…", image: UIImage(systemName: "square.and.arrow.up")) {
        [weak self] _ in self?.share()
      },
    ])
    button.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(button)
    NSLayoutConstraint.activate([
      button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
      button.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
      button.widthAnchor.constraint(equalToConstant: 48),
      button.heightAnchor.constraint(equalToConstant: 48),
    ])
    actionsButton = button
  }

  private func setBusy(_ busy: Bool) {
    guard let button = actionsButton, var configuration = button.configuration else { return }
    configuration.showsActivityIndicator = busy
    button.configuration = configuration
    button.isEnabled = !busy
  }

  private var topController: UIViewController {
    var top = fullScreenController ?? controller
    while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
    return top
  }

  private var fileName: String {
    let trimmed = title.replacingOccurrences(of: "/", with: "-")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let original = trimmed.isEmpty ? "video" : trimmed
    let path = original as NSString
    // A caption such as "Demo v1.2 final" ends in no video extension; Photos then refuses it.
    let titleExtension = Self.videoExtension(path.pathExtension)
    let suffix = ".\(titleExtension ?? Self.videoExtension(sourceURL.pathExtension) ?? "mp4")"
    let base = titleExtension == nil ? original : path.deletingPathExtension
    var name = ""
    for character in base {
      let next = name + String(character)
      if next.utf8.count + suffix.utf8.count > 240 { break }
      name = next
    }
    return "\(name.isEmpty ? "video" : name)\(suffix)"
  }

  private static func videoExtension(_ candidate: String) -> String? {
    guard !candidate.isEmpty, let type = UTType(filenameExtension: candidate),
      type.conforms(to: .movie)
    else { return nil }
    return candidate.lowercased()
  }

  /// The video as a local file: the original when it is one, else a download of it.
  @MainActor
  private func localFile() async throws -> URL {
    if sourceURL.isFileURL { return sourceURL }
    if let downloadedFile { return downloadedFile }
    let (temporary, response) = try await URLSession.shared.download(from: sourceURL)
    defer { try? FileManager.default.removeItem(at: temporary) }
    try Task.checkCancellation()
    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
      throw NSError(
        domain: "T3NativeVideo",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "The video couldn't be downloaded. Try again."]
      )
    }
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("t3-video-\(UUID().uuidString)", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let destination = directory.appendingPathComponent(fileName)
      try FileManager.default.moveItem(at: temporary, to: destination)
      downloadedFile = destination
      return destination
    } catch {
      try? FileManager.default.removeItem(at: directory)
      throw error
    }
  }

  private func cleanDownloadedFileIfPossible() {
    guard finished, actionTask == nil, !shareActive, !completionDelivered else { return }
    if let downloadedFile {
      try? FileManager.default.removeItem(at: downloadedFile.deletingLastPathComponent())
      self.downloadedFile = nil
    }
    completionDelivered = true
    completion(playbackError)
  }

  private func saveToPhotos() {
    guard actionTask == nil, !finished else { return }
    setBusy(true)
    actionTask = Task { @MainActor [self] in
      defer { actionTask = nil; cleanDownloadedFileIfPossible() }
      do {
        let file = try await localFile()
        try Task.checkCancellation()
        try await T3PhotoLibrarySave.saveVideo(at: file)
        guard !finished, !dismissRequested else { return }
        setBusy(false)
        showSaved()
      } catch {
        guard !finished, !dismissRequested else { return }
        setBusy(false)
        showError(title: "Couldn't save video", error: error)
      }
    }
  }

  private func share() {
    guard actionTask == nil, !finished else { return }
    setBusy(true)
    actionTask = Task { @MainActor [self] in
      defer { actionTask = nil; cleanDownloadedFileIfPossible() }
      do {
        let file = try await localFile()
        try Task.checkCancellation()
        guard !finished, !dismissRequested else { return }
        setBusy(false)
        let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        shareActive = true
        activity.completionWithItemsHandler = { [self] _, _, _, _ in
          shareActive = false
          cleanDownloadedFileIfPossible()
        }
        activity.popoverPresentationController?.sourceView = actionsButton
        topController.present(activity, animated: true)
      } catch {
        guard !finished, !dismissRequested else { return }
        setBusy(false)
        showError(title: "Couldn't share video", error: error)
      }
    }
  }

  private func showSaved() {
    guard let button = actionsButton, var configuration = button.configuration else { return }
    let shareImage = configuration.image
    configuration.image = UIImage(systemName: "checkmark")
    button.configuration = configuration
    UIAccessibility.post(notification: .announcement, argument: "Saved to Photos")
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak button] in
      guard let button, var restored = button.configuration else { return }
      restored.image = shareImage
      button.configuration = restored
    }
  }

  private func showError(title: String, error: Error) {
    let alert = UIAlertController(
      title: title, message: error.localizedDescription, preferredStyle: .alert
    )
    alert.addAction(UIAlertAction(title: "OK", style: .default))
    topController.present(alert, animated: true)
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    controller.player?.pause()
    actionsButton?.removeFromSuperview()
    actionsButton = nil
    actionTask?.cancel()
    if embedded {
      controller.willMove(toParent: nil)
      controller.view.removeFromSuperview()
      controller.removeFromParent()
    }
    itemObservation = nil
    controller.player = nil
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    backgroundObserver = nil
    let audioSession = AVAudioSession.sharedInstance()
    // Still what present() set, allowing the .mixWithOthers flip expo-video
    // makes when the inline players pause under this preview. A recorder that
    // claimed the session since owns it.
    if let previousAudioSession, audioSession.category == .playback,
      audioSession.mode == .moviePlayback,
      audioSession.categoryOptions.isSubset(of: [.mixWithOthers]) {
      try? audioSession.setCategory(
        previousAudioSession.category,
        mode: previousAudioSession.mode,
        options: previousAudioSession.options
      )
      // Deactivating with notification lets interrupted apps resume.
      try? audioSession.setActive(false, options: [.notifyOthersOnDeactivation])
    }
    cleanDownloadedFileIfPossible()
  }
}
