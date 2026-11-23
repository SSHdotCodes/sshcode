import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

private struct ComposerTokenPayload: Decodable, Equatable {
  let type: String
  let source: String
  let label: String
  let iconUri: String?
  let accent: String?
  let symbol: String?
  let detail: String?
  var start: Int
  var end: Int

  func rendersLike(_ other: Self) -> Bool {
    var moved = other
    moved.start = start
    moved.end = end
    // String == accepts canonically equivalent sources, but their UTF-16 lengths differ.
    return moved == self && source.utf16.elementsEqual(other.source.utf16)
  }
}

private struct ComposerSelectionPayload: Decodable, Equatable {
  let start: Int
  let end: Int
}

private struct ComposerControlledDocumentPayload: Decodable {
  let value: String
  let selection: ComposerSelectionPayload?
  let tokensJson: String
  let mostRecentEventCount: Int
  let isNativeEcho: Bool
  /// Bumped by JS when the parent empties the document (the clear after sending).
  let resetSequence: Int?
}

private struct ComposerThemePayload: Decodable {
  let text: String
  let placeholder: String
  let chipBackground: String
  let chipBorder: String
  let chipText: String
  let skillBackground: String
  let skillBorder: String
  let skillText: String
  let fileTint: String
}

private struct ComposerChipStyle {
  let tint: UIColor
  let backgroundColor: UIColor
  let borderColor: UIColor
  let textColor: UIColor
}

private enum ComposerEnterBehavior: String {
  case send
  case newline
}

private final class ComposerTextAttachment: NSTextAttachment {
  let token: ComposerTokenPayload
  var source: String { token.source }
  var label: String { token.label }

  init(token: ComposerTokenPayload, image: UIImage, size: CGSize, baselineOffset: CGFloat) {
    self.token = token
    super.init(data: nil, ofType: nil)
    self.image = image
    bounds = CGRect(x: 0, y: baselineOffset, width: size.width, height: size.height)
  }

  required init?(coder: NSCoder) {
    nil
  }
}

private final class ComposerContextAccessibilityElement: UIAccessibilityElement {
  var activate: (() -> Bool)?

  override func accessibilityActivate() -> Bool {
    activate?() ?? false
  }
}

private final class ComposerTextView: UITextView {
  private static let pastedImageDirectoryName = "t3-composer-paste"
  private static let stalePastedImageAge: TimeInterval = 60 * 60
  private static let readOnlyActions = Set([
    "cut:",
    "delete:",
    "paste:",
    "redo:",
    "toggleBoldface:",
    "toggleItalics:",
    "toggleUnderline:",
    "undo:",
  ])

  var onPasteImages: (([String]) -> Void)?
  var onPasteContext: (([String: String]) -> Void)?
  var onPasteText: ((String, NSRange) -> Void)?
  var clipboardFragment = ""
  var onSubmit: ((Bool) -> Void)?
  var isReadOnly = false
  var textPasteThresholdBytes = 0
  var maxInputChars = Int.max
  var enterBehavior: ComposerEnterBehavior = .send
  /// Shortcut HUD titles. JS supplies what the two sends actually do right now
  /// ("Queue Message" / "Steer Message"), so the iPad Command-hold list names
  /// the outcome rather than a generic "Send".
  var submitTitle = "Send Message"
  var alternateSubmitTitle = "Send Message"
  private var bypassTextPasteInterception = false

  override var keyCommands: [UIKeyCommand]? {
    var commands = super.keyCommands ?? []
    guard !isReadOnly, markedTextRange == nil else { return commands }
    // The plainer chord always performs the configured follow-up behavior and
    // the more-modified one performs its opposite, so Command is the "other
    // way" modifier whichever Return behavior is configured.
    if enterBehavior == .send {
      let submitOnReturn = UIKeyCommand(
        input: "\r",
        modifierFlags: [],
        action: #selector(submitMessage(_:))
      )
      submitOnReturn.discoverabilityTitle = submitTitle
      submitOnReturn.wantsPriorityOverSystemBehavior = true
      commands.append(submitOnReturn)

      let submitAlternate = UIKeyCommand(
        input: "\r",
        modifierFlags: .command,
        action: #selector(submitMessageAlternate(_:))
      )
      submitAlternate.discoverabilityTitle = alternateSubmitTitle
      submitAlternate.wantsPriorityOverSystemBehavior = true
      commands.append(submitAlternate)

      let newline = UIKeyCommand(
        input: "\r",
        modifierFlags: .shift,
        action: #selector(insertNewline(_:))
      )
      newline.discoverabilityTitle = "New Line"
      newline.wantsPriorityOverSystemBehavior = true
      commands.append(newline)
    } else {
      let submit = UIKeyCommand(
        input: "\r",
        modifierFlags: .command,
        action: #selector(submitMessage(_:))
      )
      submit.discoverabilityTitle = submitTitle
      submit.wantsPriorityOverSystemBehavior = true
      commands.append(submit)

      let submitAlternate = UIKeyCommand(
        input: "\r",
        modifierFlags: [.command, .shift],
        action: #selector(submitMessageAlternate(_:))
      )
      submitAlternate.discoverabilityTitle = alternateSubmitTitle
      submitAlternate.wantsPriorityOverSystemBehavior = true
      commands.append(submitAlternate)
    }
    if textPasteThresholdBytes > 0 {
      let pasteAsText = UIKeyCommand(
        input: "v",
        modifierFlags: [.command, .shift],
        action: #selector(pasteInline(_:))
      )
      pasteAsText.discoverabilityTitle = "Paste as Text"
      pasteAsText.wantsPriorityOverSystemBehavior = true
      commands.append(pasteAsText)
    }
    return commands
  }

  @objc private func submitMessage(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    onSubmit?(false)
  }

  @objc private func submitMessageAlternate(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    onSubmit?(true)
  }

  @objc private func insertNewline(_ sender: UIKeyCommand) {
    guard !isReadOnly, markedTextRange == nil else { return }
    insertText("\n")
  }

  @objc private func pasteInline(_ sender: UIKeyCommand) {
    guard !isReadOnly else {
      return
    }
    bypassTextPasteInterception = true
    defer { bypassTextPasteInterception = false }
    paste(sender)
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(submitMessage(_:)) || action == #selector(insertNewline(_:)) {
      return isEditable && !isReadOnly && markedTextRange == nil
    }
    if isReadOnly && Self.readOnlyActions.contains(NSStringFromSelector(action)) {
      return false
    }
    if action == #selector(paste(_:)) {
      let pasteboard = UIPasteboard.general
      if pasteboard.hasImages ||
        pasteboard.itemProviders.contains(where: {
          $0.canLoadObject(ofClass: UIImage.self)
        }) {
        return true
      }
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    guard !isReadOnly else {
      return
    }
    let pasteboard = UIPasteboard.general
    let context = T3ComposerClipboard.read()
    if !context["fragment", default: ""].isEmpty || context["html", default: ""].contains("data-t3-context-fragment=") {
      onPasteContext?(context)
      return
    }
    let imageProviders = pasteboard.itemProviders.filter {
      $0.canLoadObject(ofClass: UIImage.self)
    }
    if !imageProviders.isEmpty {
      loadImages(from: imageProviders)
      return
    }

    let images = pasteboard.images ?? []
    if !images.isEmpty {
      // Already decoded images have no source bytes left, so they go out as PNG.
      let encoded: [(data: Data, fileExtension: String)] = images.compactMap { image in
        image.pngData().map { (data: $0, fileExtension: "png") }
      }
      writeTemporaryImages(encoded)
      return
    }
    // pasteboard.string is only the first item; super.paste inserts every text item.
    if !bypassTextPasteInterception,
       let text = pasteboard.strings?.joined(), shouldInterceptTextPaste(text) {
      onPasteText?(text, selectedRange)
      return
    }
    super.paste(sender)
  }

  private func shouldInterceptTextPaste(_ text: String) -> Bool {
    guard textPasteThresholdBytes > 0, !text.isEmpty else { return false }
    let pastedLength = (text as NSString).length
    if pastedLength >= textPasteThresholdBytes || text.utf8.count >= textPasteThresholdBytes {
      return true
    }
    // Chips occupy one display character but expand to their source in the
    // submitted message. Measure that source, including the replaced selection.
    let sourceLength = sourceOffset(forDisplayOffset: attributedText.length)
    let selectedLength = sourceOffset(forDisplayOffset: NSMaxRange(selectedRange)) -
      sourceOffset(forDisplayOffset: selectedRange.location)
    return sourceLength - selectedLength + pastedLength > maxInputChars
  }

  override func deleteBackward() {
    guard !isReadOnly else {
      return
    }
    guard selectedRange.length == 0, selectedRange.location > 0 else {
      super.deleteBackward()
      return
    }

    let previousOffset = selectedRange.location - 1
    if textStorage.attribute(.attachment, at: previousOffset, effectiveRange: nil)
      is ComposerTextAttachment {
      replaceDisplayRange(NSRange(location: previousOffset, length: 1))
      return
    }

    super.deleteBackward()
  }

  private func replaceDisplayRange(_ range: NSRange) {
    guard let start = position(from: beginningOfDocument, offset: range.location),
          let end = position(from: start, offset: range.length),
          let textRange = textRange(from: start, to: end) else {
      return
    }
    replace(textRange, withText: "")
  }

  func loadImages(from providers: [NSItemProvider]) {
    let group = DispatchGroup()
    let lock = NSLock()
    var images = [(data: Data, fileExtension: String)?](repeating: nil, count: providers.count)

    for (index, provider) in providers.enumerated() {
      group.enter()
      let store = { (image: (data: Data, fileExtension: String)?) in
        lock.lock()
        images[index] = image
        lock.unlock()
        group.leave()
      }
      let loadPNG = {
        _ = provider.loadObject(ofClass: UIImage.self) { object, _ in
          store((object as? UIImage)?.pngData().map { ($0, "png") })
        }
      }
      // Decoding a GIF to UIImage keeps only its first frame, so pass its bytes through.
      if provider.hasItemConformingToTypeIdentifier(UTType.gif.identifier) {
        _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.gif.identifier) { data, _ in
          if let data { store((data, "gif")) } else { loadPNG() }
        }
      } else {
        loadPNG()
      }
    }

    group.notify(queue: .main) { [weak self] in
      self?.writeTemporaryImages(images.compactMap { $0 })
    }
  }

  override func copy(_ sender: Any?) {
    guard selectedRange.length > 0 else {
      return super.copy(sender)
    }
    T3ComposerClipboard.write(text: serializedText(in: selectedRange), fragment: clipboardFragment)
  }

  override func cut(_ sender: Any?) {
    guard !isReadOnly else {
      return
    }
    guard isEditable, selectedRange.length > 0 else {
      return super.cut(sender)
    }
    copy(sender)
    replaceDisplayRange(selectedRange)
  }

  func serializedText() -> String {
    serializedText(in: NSRange(location: 0, length: attributedText.length))
  }

  func serializedText(in range: NSRange) -> String {
    guard range.length > 0 else {
      return ""
    }

    let source = NSMutableString()
    let nsString = attributedText.string as NSString
    var cursor = range.location
    let end = NSMaxRange(range)
    attributedText.enumerateAttribute(.attachment, in: range) { value, attachmentRange, _ in
      if attachmentRange.location > cursor {
        source.append(
          nsString.substring(
            with: NSRange(location: cursor, length: attachmentRange.location - cursor)
          )
        )
      }
      if let attachment = value as? ComposerTextAttachment {
        source.append(attachment.source)
      } else {
        source.append(nsString.substring(with: attachmentRange))
      }
      cursor = NSMaxRange(attachmentRange)
    }
    if cursor < end {
      source.append(nsString.substring(with: NSRange(location: cursor, length: end - cursor)))
    }
    return source as String
  }

  func sourceOffset(forDisplayOffset displayOffset: Int) -> Int {
    let boundedOffset = max(0, min(attributedText.length, displayOffset))
    if boundedOffset == 0 {
      return 0
    }

    var sourceOffset = 0
    let range = NSRange(location: 0, length: boundedOffset)
    attributedText.enumerateAttribute(.attachment, in: range) { value, attributeRange, _ in
      if let attachment = value as? ComposerTextAttachment {
        sourceOffset += (attachment.source as NSString).length
      } else {
        sourceOffset += attributeRange.length
      }
    }
    return sourceOffset
  }

  private static let imageWriteQueue = DispatchQueue(label: "codes.t3.composer.pasted-images", qos: .userInitiated)

  private func writeTemporaryImages(_ images: [(data: Data, fileExtension: String)]) {
    Self.imageWriteQueue.async { [weak self] in
      let urls = images.compactMap { Self.writeTemporaryImage($0.data, fileExtension: $0.fileExtension) }
      DispatchQueue.main.async { [weak self] in
        guard let self, !self.isReadOnly, let onPasteImages = self.onPasteImages else {
          for uri in urls {
            if let url = URL(string: uri) { try? FileManager.default.removeItem(at: url) }
          }
          return
        }
        if !urls.isEmpty { onPasteImages(urls) }
      }
    }
  }

  private static func writeTemporaryImage(_ data: Data, fileExtension: String) -> String? {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(pastedImageDirectoryName, isDirectory: true)
    do {
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true
      )
      removeStaleTemporaryImages(in: directory)
      let url = directory.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
      try data.write(to: url, options: .atomic)
      return url.absoluteString
    } catch {
      return nil
    }
  }

  private static func removeStaleTemporaryImages(in directory: URL) {
    let cutoff = Date().addingTimeInterval(-stalePastedImageAge)
    guard let urls = try? FileManager.default.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
      options: [.skipsHiddenFiles]
    ) else {
      return
    }

    for url in urls {
      guard
        let values = try? url.resourceValues(
          forKeys: [.contentModificationDateKey, .isRegularFileKey]
        ),
        values.isRegularFile == true,
        let modifiedAt = values.contentModificationDate,
        modifiedAt < cutoff
      else {
        continue
      }
      try? FileManager.default.removeItem(at: url)
    }
  }
}

public final class T3ComposerEditorView: ExpoView, UITextViewDelegate, UITextDropDelegate, UIGestureRecognizerDelegate {
  // Reading layoutManager must not convert a live TextKit 2 view mid-draft.
  private let textView = ComposerTextView(usingTextLayoutManager: false)
  private let placeholderLabel = UILabel()
  private var value = ""
  private var tokensJson = "[]"
  private var tokens: [ComposerTokenPayload] = []
  private var requestedSelection: ComposerSelectionPayload?
  private var theme = ComposerThemePayload(
    text: "#262626",
    placeholder: "#8e8e93",
    chipBackground: "#f2f2f7",
    chipBorder: "#dedee3",
    chipText: "#262626",
    skillBackground: "#f9e8fb",
    skillBorder: "#e5a6eb",
    skillText: "#a21caf",
    fileTint: "#737373"
  )
  private var fontFamily = "DMSans-Regular"
  private var fontSize: CGFloat = 14
  private var lineHeight: CGFloat = 20
  private var contentInsetVertical: CGFloat = 0
  private var shouldAutoFocus = false
  private var didAutoFocus = false
  private var isReadOnly = false
  private var isApplyingControlledValue = false
  private var nativeEventCount = 0
  private var lastPasteEventCount = 0
  /// The newest reset applied; every event carries it so JS can drop ones sent before it.
  private var appliedResetSequence = 0
  private var lastContentSize = CGSize.zero
  private var iconImages: [String: UIImage] = [:]
  private var pendingIconUris = Set<String>()
  private var tokensNeedRebuild = false
  private var chipsNeedMeasuredWidth = false
  private var hasDeferredForcedRebuild = false
  private var pendingContentOffset: CGPoint?
  private var needsSelectionReveal = false
  private var selectionBeforeFocusingTap: (selection: ComposerSelectionPayload, value: String)?

  let onComposerChange = EventDispatcher()
  let onComposerSelectionChange = EventDispatcher()
  let onComposerFocus = EventDispatcher()
  let onComposerBlur = EventDispatcher()
  let onComposerSubmit = EventDispatcher()
  let onComposerPasteImages = EventDispatcher()
  let onComposerContextPress = EventDispatcher()
  let onComposerPasteContext = EventDispatcher()
  let onComposerPasteText = EventDispatcher()
  let onComposerContentSizeChange = EventDispatcher()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = false
    textView.delegate = self
    textView.textDropDelegate = self
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.keyboardDismissMode = .interactive
    textView.alwaysBounceVertical = false
    textView.showsVerticalScrollIndicator = true
    textView.adjustsFontForContentSizeCategory = true
    if #available(iOS 26.0, *) {
      // A nearby bar's edge backdrop must not paint over the draft text.
      let edges = [textView.topEdgeEffect, textView.leftEdgeEffect, textView.bottomEdgeEffect, textView.rightEdgeEffect]
      for edge in edges {
        edge.isHidden = true
      }
    }
    // iOS holds an inline prediction as marked text, so it went out with the
    // message as if typed, and the clear after sending waited on it and lost.
    // The suggestion bar above the keyboard still offers the same words.
    if #available(iOS 17.0, *) {
      textView.inlinePredictionType = .no
    }
    textView.onPasteImages = { [weak self] urls in
      self?.onComposerPasteImages(["uris": urls])
    }
    textView.onPasteContext = { [weak self] context in
      guard let self else { return }
      let selection = self.sourceSelection()
      self.nativeEventCount += 1
      self.lastPasteEventCount = self.nativeEventCount
      var payload: [String: Any] = context
      payload["value"] = self.textView.serializedText()
      payload["eventCount"] = self.nativeEventCount
      payload["resetSequence"] = self.appliedResetSequence
      payload["selection"] = ["start": selection.start, "end": selection.end]
      self.onComposerPasteContext(payload)
    }
    textView.onPasteText = { [weak self] text, _ in
      guard let self else { return }
      let selection = self.sourceSelection()
      self.nativeEventCount += 1
      self.lastPasteEventCount = self.nativeEventCount
      self.onComposerPasteText([
        "value": self.textView.serializedText(),
        "eventCount": self.nativeEventCount,
        "resetSequence": self.appliedResetSequence,
        "text": text,
        "selection": ["start": selection.start, "end": selection.end],
      ])
    }
    textView.onSubmit = { [weak self] alternate in
      self?.onComposerSubmit(["alternate": alternate])
    }
    let contextTap = UITapGestureRecognizer(target: self, action: #selector(openContext(_:)))
    contextTap.cancelsTouchesInView = false
    contextTap.delegate = self
    textView.addGestureRecognizer(contextTap)
    addSubview(textView)

    placeholderLabel.numberOfLines = 0
    placeholderLabel.adjustsFontForContentSizeCategory = true
    addSubview(placeholderLabel)
    applyTypography()
    applyTheme()
  }

  @objc private func openContext(_ recognizer: UITapGestureRecognizer) {
    guard let (index, attachment) = contextAttachment(at: recognizer.location(in: textView)) else {
      textView.becomeFirstResponder()
      if selectionBeforeFocusingTap != nil {
        // UIKit places the caret from its own tap recognizer during this same touch.
        DispatchQueue.main.async { [weak self] in
          self?.restoreSelectionBeforeFocusingTap()
        }
      }
      return
    }
    openContext(index: index, attachment: attachment)
  }

  private func openContext(index: Int, attachment: ComposerTextAttachment) {
    let start = textView.sourceOffset(forDisplayOffset: index)
    onComposerContextPress(["source": attachment.source, "start": start, "end": start + (attachment.source as NSString).length])
  }

  public override var accessibilityElements: [Any]? {
    get {
      var elements: [Any] = [textView]
      let layout = textView.layoutManager
      textView.textStorage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: textView.textStorage.length)) { value, range, _ in
        guard let attachment = value as? ComposerTextAttachment else { return }
        let glyphRange = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        let rect = layout.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer)
          .offsetBy(dx: textView.textContainerInset.left, dy: textView.textContainerInset.top)
        guard rect.intersects(textView.bounds) else { return }
        let element = ComposerContextAccessibilityElement(accessibilityContainer: self)
        element.accessibilityLabel = attachment.label
        element.accessibilityTraits = .button
        element.accessibilityFrameInContainerSpace = textView.convert(rect, to: self)
        element.activate = { [weak self] in
          guard let self, range.location < self.textView.textStorage.length,
                self.textView.textStorage.attribute(.attachment, at: range.location, effectiveRange: nil) as? ComposerTextAttachment === attachment else { return false }
          self.openContext(index: range.location, attachment: attachment)
          return true
        }
        elements.append(element)
      }
      return elements
    }
    set { super.accessibilityElements = newValue }
  }

  public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    // The collapsed editor only shows the draft's first line, so a tap that expands an
    // overflowing draft returns to the caret it was left at instead of moving it there.
    let collapsedOverflow = !textView.isFirstResponder && !textView.isScrollEnabled && draftOverflowsBounds()
    selectionBeforeFocusingTap = collapsedOverflow ? (sourceSelection(), value) : nil
    return true
  }

  public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    true
  }

  public func textView(_ textView: UITextView, shouldInteractWith textAttachment: NSTextAttachment, in characterRange: NSRange, interaction: UITextItemInteraction) -> Bool {
    // A chip is text context, not an image to save to the camera roll.
    !(textAttachment is ComposerTextAttachment)
  }

  private func contextAttachment(at point: CGPoint) -> (Int, ComposerTextAttachment)? {
    let containerPoint = CGPoint(x: point.x - textView.textContainerInset.left, y: point.y - textView.textContainerInset.top)
    let layout = textView.layoutManager
    let index = layout.characterIndex(for: containerPoint, in: textView.textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
    guard index < textView.textStorage.length,
          let attachment = textView.textStorage.attribute(.attachment, at: index, effectiveRange: nil) as? ComposerTextAttachment else { return nil }
    let glyphRange = layout.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
    guard layout.boundingRect(forGlyphRange: glyphRange, in: textView.textContainer).contains(containerPoint) else { return nil }
    return (index, attachment)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    let previousSize = textView.bounds.size
    textView.frame = bounds
    if chipsNeedMeasuredWidth, bounds.width > 0 {
      chipsNeedMeasuredWidth = false
      applyControlledDocument(force: true)
    }
    if textView.isScrollEnabled, bounds.width > 0, bounds.height > 0 {
      textView.layoutIfNeeded()
      if let offset = pendingContentOffset {
        let minY = -textView.adjustedContentInset.top
        let maxY = max(minY, textView.contentSize.height - bounds.height + textView.adjustedContentInset.bottom)
        textView.setContentOffset(CGPoint(x: offset.x, y: min(maxY, max(minY, offset.y))), animated: false)
        pendingContentOffset = nil
      }
      if needsSelectionReveal || (previousSize != bounds.size && textView.isFirstResponder) {
        needsSelectionReveal = false
        if let selection = textView.selectedTextRange {
          textView.scrollRectToVisible(textView.caretRect(for: selection.end), animated: false)
        }
      }
    }
    let placeholderX = textView.textContainerInset.left + textView.textContainer.lineFragmentPadding
    let placeholderY = textView.textContainerInset.top
    let placeholderWidth = max(
      0,
      bounds.width - placeholderX - textView.textContainerInset.right -
        textView.textContainer.lineFragmentPadding
    )
    placeholderLabel.frame = CGRect(
      x: placeholderX,
      y: placeholderY,
      width: placeholderWidth,
      height: max(lineHeight, placeholderLabel.font.lineHeight)
    )
    emitContentSizeIfNeeded()
  }

  func setClipboardFragment(_ fragment: String) {
    textView.clipboardFragment = fragment
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, shouldAutoFocus, !didAutoFocus else {
      return
    }
    didAutoFocus = true
    DispatchQueue.main.async { [weak self] in
      self?.textView.becomeFirstResponder()
    }
  }

  func setControlledDocumentJson(_ documentJson: String) {
    guard let document = decode(ComposerControlledDocumentPayload.self, from: documentJson) else {
      return
    }
    // A reset wins over the revision guard: the keyboard can commit an autocorrection (a newer
    // event) between JS reading the draft to send and its clear arriving here.
    let isReset = (document.resetSequence ?? 0) > appliedResetSequence
    guard isReset || document.mostRecentEventCount >= nativeEventCount else {
      return
    }
    if !isReset && document.isNativeEcho && textView.serializedText() != document.value {
      return
    }
    if isReset {
      // Drop whatever the keyboard still holds for the old text (a pending correction, marked
      // text) so it can't land on the cleared editor.
      textView.inputDelegate?.textWillChange(textView)
      if textView.markedTextRange != nil {
        textView.unmarkText()
      }
    }
    if tokensJson != document.tokensJson {
      tokensJson = document.tokensJson
      let nextTokens = decode([ComposerTokenPayload].self, from: document.tokensJson) ?? []
      // Rebuild only when a chip on screen would look different: typing before a chip moves its
      // offsets, and Undo restores the chip it removed. A rebuild there makes iOS autocorrect
      // behind the caret, and replacing the text drops UIKit's Redo.
      tokensNeedRebuild = tokensNeedRebuild || !nextTokens.elementsEqual(renderedChipTokens(), by: { $0.rendersLike($1) })
      tokens = nextTokens
    }
    let previousSelection = sourceSelection()
    value = document.value
    requestedSelection = document.selection
    applyControlledDocument(force: tokensNeedRebuild || isReset)
    applyRequestedSelection()
    cancelFocusingTapRestoreIfSelectionMoved(from: previousSelection)
    if tokensMatchCurrentValue() {
      tokensNeedRebuild = false
    }
    if isReset {
      textView.inputDelegate?.textDidChange(textView)
      appliedResetSequence = document.resetSequence ?? 0
      lastPasteEventCount = 0
      emitResetAck()
    }
  }

  func setThemeJson(_ themeJson: String) {
    guard let nextTheme = decode(ComposerThemePayload.self, from: themeJson) else {
      return
    }
    theme = nextTheme
    applyTheme()
    applyControlledDocument(force: true)
  }

  func setPlaceholder(_ placeholder: String) {
    placeholderLabel.text = placeholder
    textView.accessibilityLabel = placeholder
    setNeedsLayout()
  }

  func setFontFamily(_ fontFamily: String) {
    self.fontFamily = fontFamily
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setFontSize(_ fontSize: CGFloat) {
    self.fontSize = fontSize
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setLineHeight(_ lineHeight: CGFloat) {
    self.lineHeight = lineHeight
    applyTypography()
    applyControlledDocument(force: true)
  }

  func setContentInsetVertical(_ contentInsetVertical: CGFloat) {
    self.contentInsetVertical = contentInsetVertical
    textView.textContainerInset = UIEdgeInsets(
      top: contentInsetVertical,
      left: 0,
      bottom: contentInsetVertical,
      right: 0
    )
    setNeedsLayout()
  }

  func setEditable(_ editable: Bool) {
    textView.isEditable = editable
  }

  func setReadOnly(_ readOnly: Bool) {
    isReadOnly = readOnly
    textView.isReadOnly = readOnly
  }

  func setScrollEnabled(_ scrollEnabled: Bool) {
    guard textView.isScrollEnabled != scrollEnabled else { return }
    if !scrollEnabled {
      // Disabling scrolling discards UITextView's offset. Restore it after
      // expansion has laid out the text, regardless of prop update order.
      pendingContentOffset = pendingContentOffset ?? textView.contentOffset
    }
    textView.isScrollEnabled = scrollEnabled
    if scrollEnabled {
      revealSelectionAfterLayout()
    }
  }

  func setAutoFocus(_ autoFocus: Bool) {
    shouldAutoFocus = autoFocus
  }

  func setAutoCorrect(_ autoCorrect: Bool) {
    textView.autocorrectionType = autoCorrect ? .yes : .no
  }

  func setSpellCheck(_ spellCheck: Bool) {
    textView.spellCheckingType = spellCheck ? .yes : .no
  }

  func setEnterBehavior(_ behavior: String) {
    textView.enterBehavior = ComposerEnterBehavior(rawValue: behavior) ?? .send
  }

  func setSubmitTitle(_ title: String) {
    textView.submitTitle = title
  }

  func setAlternateSubmitTitle(_ title: String) {
    textView.alternateSubmitTitle = title
  }

  func setTextPasteThresholdBytes(_ threshold: Int) {
    textView.textPasteThresholdBytes = threshold
  }

  func setMaxInputChars(_ maxInputChars: Int) {
    textView.maxInputChars = maxInputChars
  }

  func focusEditor() {
    textView.becomeFirstResponder()
  }

  func readState() -> [String: Any] {
    let selection = sourceSelection()
    return [
      "value": textView.serializedText(),
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
      "resetSequence": appliedResetSequence,
      "pasteEventCount": lastPasteEventCount,
    ]
  }

  func blurEditor() {
    textView.resignFirstResponder()
  }

  func setSelection(start: Int, end: Int) {
    let previousSelection = sourceSelection()
    requestedSelection = ComposerSelectionPayload(start: start, end: end)
    applyRequestedSelection()
    cancelFocusingTapRestoreIfSelectionMoved(from: previousSelection)
  }

  public func textViewDidChange(_ textView: UITextView) {
    emitTextChange()
  }

  public func textViewDidChangeSelection(_ textView: UITextView) {
    guard !isApplyingControlledValue else {
      return
    }
    restoreBaseTypingAttributes()
    // UIKit moves the selection before textViewDidChange runs. Emitting here
    // would pair the post-edit text with a pre-edit revision counter, so let
    // the change event that follows carry both; only pure caret moves emit.
    guard self.textView.serializedText() == value else {
      return
    }
    emitSelection()
  }

  public func textView(
    _ textView: UITextView,
    shouldChangeTextIn range: NSRange,
    replacementText text: String
  ) -> Bool {
    restoreBaseTypingAttributes()
    return !isReadOnly
  }

  public func textDroppableView(
    _ textDroppableView: UIView & UITextDroppable,
    proposalForDrop drop: UITextDropRequest
  ) -> UITextDropProposal {
    guard !isReadOnly else {
      return UITextDropProposal(operation: .cancel)
    }
    guard droppedImageProviders(in: drop) != nil else {
      return drop.suggestedProposal
    }

    // The composer owns image drops so UIKit does not insert NSTextAttachments
    // that the controlled plain-text value cannot represent.
    let proposal = UITextDropProposal(operation: .copy)
    proposal.dropAction = .insert
    proposal.dropPerformer = .delegate
    return proposal
  }

  public func textDroppableView(
    _ textDroppableView: UIView & UITextDroppable,
    willPerformDrop drop: UITextDropRequest
  ) {
    guard !isReadOnly else {
      return
    }
    guard let imageProviders = droppedImageProviders(in: drop) else {
      return
    }
    textView.loadImages(from: imageProviders)
  }

  private func droppedImageProviders(in drop: UITextDropRequest) -> [NSItemProvider]? {
    let providers = drop.dropSession.items.map(\.itemProvider)
    guard !providers.isEmpty,
          providers.allSatisfy({ $0.canLoadObject(ofClass: UIImage.self) }) else {
      return nil
    }
    return providers
  }

  public func textViewDidBeginEditing(_ textView: UITextView) {
    revealSelectionAfterLayout()
    onComposerFocus()
  }

  public func textViewDidEndEditing(_ textView: UITextView) {
    onComposerBlur()
  }

  private func applyControlledDocument(force: Bool = false) {
    // Rebuilding the attributed string tears down an active IME composition.
    // Skip while marked text exists; committing the composition sends a new
    // value from JS, and that update rebuilds, keeping any skipped force.
    if textView.markedTextRange != nil {
      hasDeferredForcedRebuild = hasDeferredForcedRebuild || force
      updatePlaceholderVisibility()
      return
    }
    let shouldForce = force || hasDeferredForcedRebuild
    let currentSource = textView.serializedText()
    guard shouldForce || currentSource != value || !documentMatchesExpectedTokens() else {
      updatePlaceholderVisibility()
      return
    }
    hasDeferredForcedRebuild = false

    let previousSelection = sourceSelection()
    if textView.isScrollEnabled {
      pendingContentOffset = pendingContentOffset ?? textView.contentOffset
    }
    isApplyingControlledValue = true
    textView.attributedText = makeAttributedDocument()
    let targetSelection = requestedSelection ?? previousSelection
    requestedSelection = nil
    textView.selectedRange = displayRange(for: targetSelection)
    restoreBaseTypingAttributes()
    isApplyingControlledValue = false
    if currentSource != value || previousSelection.start != targetSelection.start || previousSelection.end != targetSelection.end {
      revealSelectionAfterLayout()
    } else {
      setNeedsLayout()
    }
    updatePlaceholderVisibility()
    emitContentSizeIfNeeded()
  }

  private func makeAttributedDocument() -> NSAttributedString {
    let result = NSMutableAttributedString()
    let source = value as NSString
    var cursor = 0
    let validTokens = tokens.filter {
      $0.start >= cursor &&
        $0.end > $0.start &&
        $0.end <= source.length &&
        source.substring(with: NSRange(location: $0.start, length: $0.end - $0.start)) == $0.source
    }

    for token in validTokens {
      if token.start < cursor {
        continue
      }
      if token.start > cursor {
        appendPlainText(
          source.substring(with: NSRange(location: cursor, length: token.start - cursor)),
          to: result
        )
      }
      result.append(makeAttachmentString(token))
      cursor = token.end
    }
    if cursor < source.length {
      appendPlainText(
        source.substring(with: NSRange(location: cursor, length: source.length - cursor)),
        to: result
      )
    }
    return result
  }

  private func appendPlainText(_ text: String, to result: NSMutableAttributedString) {
    result.append(NSAttributedString(string: text, attributes: baseAttributes()))
  }

  private func makeAttachmentString(_ token: ComposerTokenPayload) -> NSAttributedString {
    let isSkill = token.type == "skill"
    let accent = token.accent.flatMap { UIColor(composerHex: $0) }
    let foreground = UIColor(composerHex: theme.chipText) ?? .label
    let border = UIColor(composerHex: theme.chipBorder) ?? .separator
    let tint = accent.map { blend($0, over: foreground, weight: 0.22) }
      ?? UIColor(composerHex: isSkill ? theme.skillText : theme.fileTint) ?? .secondaryLabel
    let iconName = token.symbol ?? (isSkill ? "cube" : "doc")
    let iconImage = token.iconUri.flatMap(iconImage(for:))
    let style = ComposerChipStyle(
      tint: tint,
      backgroundColor: accent?.withAlphaComponent(0.11) ?? UIColor(
        composerHex: isSkill ? theme.skillBackground : theme.chipBackground
      ) ?? .secondarySystemFill,
      borderColor: accent.map { blend($0, over: border, weight: 0.34) } ?? UIColor(
        composerHex: isSkill ? theme.skillBorder : theme.chipBorder
      ) ?? .separator,
      textColor: tint
    )
    let image = renderChip(
      label: token.label,
      detail: token.detail,
      iconName: iconName,
      iconImage: iconImage,
      style: style
    )
    let font = UIFont(name: fontFamily, size: fontSize)
      ?? UIFont.systemFont(ofSize: fontSize)
    let baselineOffset = floor((font.capHeight - image.size.height) / 2)
    let attachment = ComposerTextAttachment(
      token: token,
      image: image,
      size: image.size,
      baselineOffset: baselineOffset
    )
    let attributedAttachment = NSMutableAttributedString(attachment: attachment)
    attributedAttachment.addAttributes(
      baseAttributes(),
      range: NSRange(location: 0, length: attributedAttachment.length)
    )
    return attributedAttachment
  }

  /// Chip glyphs with no SF Symbol that reads correctly. A pull request would otherwise land on
  /// `arrow.triangle.branch`, a road-sign fork that says "branch", not "pull request", so it is
  /// drawn from the same lucide geometry web and Android use.
  private static func vectorIcon(named name: String, size: CGFloat, color: UIColor) -> UIImage? {
    guard name == "git-pull-request" else { return nil }
    return UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
      let s = size / 24  // lucide authors on a 24pt grid.
      let path = UIBezierPath()
      for centre in [CGPoint(x: 18 * s, y: 18 * s), CGPoint(x: 6 * s, y: 6 * s)] {
        path.append(UIBezierPath(arcCenter: centre, radius: 3 * s, startAngle: 0,
                                 endAngle: .pi * 2, clockwise: true))
      }
      path.move(to: CGPoint(x: 13 * s, y: 6 * s))
      path.addLine(to: CGPoint(x: 16 * s, y: 6 * s))
      path.addCurve(to: CGPoint(x: 18 * s, y: 8 * s),
                    controlPoint1: CGPoint(x: 17.1 * s, y: 6 * s),
                    controlPoint2: CGPoint(x: 18 * s, y: 6.9 * s))
      path.addLine(to: CGPoint(x: 18 * s, y: 15 * s))
      path.move(to: CGPoint(x: 6 * s, y: 9 * s))
      path.addLine(to: CGPoint(x: 6 * s, y: 21 * s))
      path.lineWidth = 2 * s
      path.lineCapStyle = .round
      path.lineJoinStyle = .round
      color.setStroke()
      path.stroke()
    }
  }

  private func renderChip(
    label: String,
    detail: String?,
    iconName: String,
    iconImage: UIImage?,
    style: ComposerChipStyle
  ) -> UIImage {
    // Kept in step with `T3ContextChipVectorIcon` in the markdown module: a chip drawn here and
    // the same chip drawn in a sent message have to be the same picture.
    let chipFontSize = fontSize * 0.86
    let font = UIFont(name: "DMSans-Medium", size: chipFontSize)
      ?? UIFont.systemFont(ofSize: chipFontSize, weight: .medium)
    let fallbackIcon = Self.vectorIcon(named: iconName, size: 14, color: style.textColor)
      ?? UIImage(
        systemName: iconName,
        withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .medium)
      )
    let icon = iconImage ?? fallbackIcon
    // The size reads as metadata, not part of the name, so it renders a step down from the
    // label the way the web chip does.
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .left
    let detailFont = UIFont(name: "DMSans-Medium", size: chipFontSize * 0.84)
      ?? UIFont.systemFont(ofSize: chipFontSize * 0.84, weight: .medium)
    let attributedLabel = NSMutableAttributedString(
      string: label,
      attributes: [.font: font, .foregroundColor: style.textColor, .paragraphStyle: paragraph]
    )
    if let detail, !detail.isEmpty {
      attributedLabel.append(
        NSAttributedString(
          string: " \(detail)",
          attributes: [
            .font: detailFont,
            .foregroundColor: style.textColor,
            .paragraphStyle: paragraph,
          ]
        )
      )
    }
    let iconWidth: CGFloat = icon == nil ? 0 : chipFontSize * 1.17
    let iconGap: CGFloat = icon == nil ? 0 : chipFontSize * 0.33
    let padding = chipFontSize * 0.5
    let height = ceil(chipFontSize * 1.41)
    // A long path would otherwise draw a chip wider than the composer and clip. Cap the label
    // to the text the editor can actually show and truncate inside it, as Android's
    // `maximumWidth` does, so the chip always fits the line it sits on.
    let availableWidth = textView.textContainer.size.width > 0
      ? textView.textContainer.size.width - textView.textContainer.lineFragmentPadding * 2
      : (textView.window?.bounds.width ?? bounds.width)
    if availableWidth <= 0 {
      chipsNeedMeasuredWidth = true
    }
    let maximumLabelWidth = max(chipFontSize * 3, availableWidth - padding * 2 - iconWidth - iconGap)
    paragraph.lineBreakMode = .byTruncatingMiddle
    attributedLabel.addAttribute(
      .paragraphStyle,
      value: paragraph,
      range: NSRange(location: 0, length: attributedLabel.length)
    )
    let measured = attributedLabel.size()
    let textSize = CGSize(width: min(measured.width, maximumLabelWidth), height: measured.height)
    let width = ceil(padding * 2 + iconWidth + iconGap + textSize.width)
    let format = UIGraphicsImageRendererFormat.preferred()
    format.opaque = false
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
    return renderer.image { context in
      let rect = CGRect(origin: .zero, size: CGSize(width: width, height: height))
      let path = UIBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), cornerRadius: chipFontSize * 0.5)
      style.backgroundColor.setFill()
      path.fill()
      style.borderColor.setStroke()
      path.lineWidth = 1
      path.stroke()

      var x = padding
      if let icon {
        let renderedIcon = iconImage == nil
          ? icon.withTintColor(style.tint, renderingMode: .alwaysOriginal)
          : icon
        renderedIcon.draw(
          in: CGRect(x: x, y: (height - iconWidth) / 2, width: iconWidth, height: iconWidth)
        )
        x += iconWidth + iconGap
      }
      // Exactly the measured width: a spare pixel here would let a capped label draw past
      // the cap instead of truncating inside it.
      attributedLabel.draw(
        in: CGRect(x: x, y: (height - textSize.height) / 2, width: textSize.width, height: textSize.height)
      )
      context.cgContext.setAllowsAntialiasing(true)
    }
  }

  private func blend(_ accent: UIColor, over base: UIColor, weight: CGFloat) -> UIColor {
    var ar: CGFloat = 0, ag: CGFloat = 0, ab: CGFloat = 0, aa: CGFloat = 0
    var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
    accent.getRed(&ar, green: &ag, blue: &ab, alpha: &aa)
    base.getRed(&br, green: &bg, blue: &bb, alpha: &ba)
    return UIColor(
      red: ar * weight + br * (1 - weight),
      green: ag * weight + bg * (1 - weight),
      blue: ab * weight + bb * (1 - weight),
      alpha: aa * weight + ba * (1 - weight)
    )
  }

  private func iconImage(for uri: String) -> UIImage? {
    if let image = iconImages[uri] {
      return image
    }
    guard !pendingIconUris.contains(uri), let url = URL(string: uri) else {
      return nil
    }

    if url.isFileURL, let image = UIImage(contentsOfFile: url.path) {
      iconImages[uri] = image
      return image
    }

    pendingIconUris.insert(uri)
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let self, let data, let image = UIImage(data: data) else {
        DispatchQueue.main.async {
          self?.pendingIconUris.remove(uri)
        }
        return
      }
      DispatchQueue.main.async {
        self.pendingIconUris.remove(uri)
        self.iconImages[uri] = image
        self.applyControlledDocument(force: true)
      }
    }.resume()
    return nil
  }

  private func baseAttributes() -> [NSAttributedString.Key: Any] {
    let font = UIFont(name: fontFamily, size: fontSize)
      ?? UIFont.systemFont(ofSize: fontSize)
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    return [
      .font: font,
      .foregroundColor: UIColor(composerHex: theme.text) ?? .label,
      .paragraphStyle: paragraph,
    ]
  }

  private func applyTypography() {
    let font = UIFont(name: fontFamily, size: fontSize)
      ?? UIFont.systemFont(ofSize: fontSize)
    textView.font = font
    restoreBaseTypingAttributes()
    placeholderLabel.font = font
    setNeedsLayout()
  }

  private func restoreBaseTypingAttributes() {
    guard textView.markedTextRange == nil else {
      return
    }
    textView.typingAttributes = baseAttributes()
  }

  private func applyTheme() {
    textView.textColor = UIColor(composerHex: theme.text) ?? .label
    placeholderLabel.textColor = UIColor(composerHex: theme.placeholder) ?? .placeholderText
    tintColor = UIColor.systemBlue
  }

  private func emitTextChange() {
    guard !isApplyingControlledValue else {
      return
    }
    value = textView.serializedText()
    revealSelectionAfterLayout()
    let selection = sourceSelection()
    nativeEventCount += 1
    onComposerChange([
      "value": value,
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
      "resetSequence": appliedResetSequence,
    ])
    updatePlaceholderVisibility()
    emitContentSizeIfNeeded()
  }

  /// Confirms an applied reset. JS acknowledges the revision and accepts this editor's events
  /// again, but keeps the parent's value (it may have restored a draft since asking).
  private func emitResetAck() {
    value = textView.serializedText()
    let selection = sourceSelection()
    nativeEventCount += 1
    onComposerChange([
      "value": value,
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
      "resetSequence": appliedResetSequence,
      "resetAck": true,
    ])
    updatePlaceholderVisibility()
    emitContentSizeIfNeeded()
  }

  private func emitSelection() {
    // Caret moves advance the revision counter like text edits do: a
    // controlled payload computed before this move is stale and must fail the
    // revision guard instead of yanking the caret back mid-typing.
    let currentValue = textView.serializedText()
    let selection = sourceSelection()
    nativeEventCount += 1
    onComposerSelectionChange([
      "value": currentValue,
      "selection": ["start": selection.start, "end": selection.end],
      "eventCount": nativeEventCount,
      "resetSequence": appliedResetSequence,
    ])
  }

  private func sourceSelection() -> ComposerSelectionPayload {
    ComposerSelectionPayload(
      start: textView.sourceOffset(forDisplayOffset: textView.selectedRange.location),
      end: textView.sourceOffset(forDisplayOffset: NSMaxRange(textView.selectedRange))
    )
  }

  private func displayRange(for selection: ComposerSelectionPayload) -> NSRange {
    let start = displayOffset(forSourceOffset: selection.start)
    let end = displayOffset(forSourceOffset: selection.end)
    return NSRange(location: start, length: max(0, end - start))
  }

  private func displayOffset(forSourceOffset sourceOffset: Int) -> Int {
    let boundedOffset = max(0, min((value as NSString).length, sourceOffset))
    var collapsedLength = 0
    for token in tokens where token.end <= boundedOffset {
      collapsedLength += max(0, token.end - token.start - 1)
    }
    if let token = tokens.first(where: { $0.start < boundedOffset && boundedOffset < $0.end }) {
      return token.start - collapsedLength + 1
    }
    return boundedOffset - collapsedLength
  }

  private func applyRequestedSelection() {
    guard let requestedSelection else {
      return
    }
    let nextRange = displayRange(for: requestedSelection)
    guard nextRange.location <= textView.attributedText.length,
          NSMaxRange(nextRange) <= textView.attributedText.length else {
      return
    }
    self.requestedSelection = nil
    // Programmatically assigning selectedRange resets the keyboard's
    // autocorrect and predictive-text context even when the range is
    // unchanged, so a no-op assignment must be skipped.
    guard !NSEqualRanges(nextRange, textView.selectedRange) else {
      return
    }
    isApplyingControlledValue = true
    textView.selectedRange = nextRange
    isApplyingControlledValue = false
    revealSelectionAfterLayout()
  }

  private func restoreSelectionBeforeFocusingTap() {
    guard let snapshot = selectionBeforeFocusingTap else {
      return
    }
    selectionBeforeFocusingTap = nil
    // A draft that changed during the touch, such as a transcript landing, owns the caret now.
    guard textView.isFirstResponder, textView.markedTextRange == nil, value == snapshot.value else {
      return
    }
    let range = displayRange(for: snapshot.selection)
    guard !NSEqualRanges(range, textView.selectedRange) else {
      return
    }
    textView.selectedRange = range
    revealSelectionAfterLayout()
  }

  private func cancelFocusingTapRestoreIfSelectionMoved(from previousSelection: ComposerSelectionPayload) {
    if sourceSelection() != previousSelection {
      selectionBeforeFocusingTap = nil
    }
  }

  private func draftOverflowsBounds() -> Bool {
    let size = textView.sizeThatFits(CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude))
    return size.height > textView.bounds.height + 1
  }

  private func revealSelectionAfterLayout() {
    needsSelectionReveal = true
    setNeedsLayout()
  }

  private func updatePlaceholderVisibility() {
    placeholderLabel.isHidden = !value.isEmpty
  }

  private func emitContentSizeIfNeeded() {
    let nextSize = textView.contentSize
    guard abs(nextSize.width - lastContentSize.width) > 0.5 ||
      abs(nextSize.height - lastContentSize.height) > 0.5 else {
      return
    }
    lastContentSize = nextSize
    onComposerContentSizeChange(["width": nextSize.width, "height": nextSize.height])
  }

  private func decode<T: Decodable>(_ type: T.Type, from json: String) -> T? {
    guard let data = json.data(using: .utf8) else {
      return nil
    }
    return try? JSONDecoder().decode(type, from: data)
  }

  private func tokensMatchCurrentValue() -> Bool {
    let source = value as NSString
    return tokens.allSatisfy {
      $0.start >= 0 &&
        $0.end > $0.start &&
        $0.end <= source.length &&
        source.substring(with: NSRange(location: $0.start, length: $0.end - $0.start)) == $0.source
    }
  }

  private func renderedChipTokens() -> [ComposerTokenPayload] {
    var rendered: [ComposerTokenPayload] = []
    textView.textStorage.enumerateAttribute(
      .attachment,
      in: NSRange(location: 0, length: textView.textStorage.length)
    ) { value, _, _ in
      if let attachment = value as? ComposerTextAttachment {
        rendered.append(attachment.token)
      }
    }
    return rendered
  }

  private func documentMatchesExpectedTokens() -> Bool {
    let source = value as NSString
    let expectedChips = tokens.compactMap { token -> (Int, String)? in
      guard token.start >= 0,
            token.end > token.start,
            token.end <= source.length,
            source.substring(
              with: NSRange(location: token.start, length: token.end - token.start)
            ) == token.source else {
        return nil
      }
      return (token.start, token.source)
    }
    var renderedChips: [(Int, String)] = []
    var sourceOffset = 0
    textView.attributedText.enumerateAttribute(
      .attachment,
      in: NSRange(location: 0, length: textView.attributedText.length)
    ) { value, range, _ in
      if let attachment = value as? ComposerTextAttachment {
        renderedChips.append((sourceOffset, attachment.source))
        sourceOffset += (attachment.source as NSString).length
      } else {
        sourceOffset += range.length
      }
    }
    return renderedChips.elementsEqual(expectedChips, by: ==)
  }
}

private extension UIColor {
  convenience init?(composerHex hex: String?) {
    guard var value = hex?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
      return nil
    }
    if value.hasPrefix("#") {
      value.removeFirst()
    }
    guard value.count == 6 || value.count == 8,
          let raw = UInt64(value, radix: 16) else {
      return nil
    }
    if value.count == 8 {
      self.init(
        red: CGFloat((raw >> 24) & 0xff) / 255,
        green: CGFloat((raw >> 16) & 0xff) / 255,
        blue: CGFloat((raw >> 8) & 0xff) / 255,
        alpha: CGFloat(raw & 0xff) / 255
      )
    } else {
      self.init(
        red: CGFloat((raw >> 16) & 0xff) / 255,
        green: CGFloat((raw >> 8) & 0xff) / 255,
        blue: CGFloat(raw & 0xff) / 255,
        alpha: 1
      )
    }
  }
}
