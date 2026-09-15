import ARKit
import Foundation
import SceneKit
import UIKit

/// Live camera preview, attached to the SAME ARSession the scanner is running.
///
/// Starting a second AR session (or a plain AVCaptureSession) for the preview
/// would fight the scanner for the camera and quietly halve the frame rate.
/// Sharing the session is not an optimisation here, it is the only correct
/// option.
final class ARScannerPreviewView: UIView {

    private let sceneView = ARSCNView(frame: .zero)

    /// Draw ARKit's feature points. Useful while scanning — sparse points mean
    /// the tracker is about to struggle, and you can see it before it happens.
    @objc var showFeaturePoints: Bool = false {
        didSet {
            sceneView.debugOptions = showFeaturePoints
                ? [ARSCNDebugOptions.showFeaturePoints]
                : []
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        setUp()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUp()
    }

    private func setUp() {
        sceneView.session = ARScannerModule.controller.session
        sceneView.automaticallyUpdatesLighting = false
        // The preview is a viewfinder, not the product. Rendering it at 60 fps
        // costs real GPU time and battery for no benefit — the operator is
        // looking at where the phone points, not at motion detail.
        sceneView.preferredFramesPerSecond = 30
        sceneView.rendersContinuously = false
        sceneView.antialiasingMode = .none
        sceneView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(sceneView)
        NSLayoutConstraint.activate([
            sceneView.topAnchor.constraint(equalTo: topAnchor),
            sceneView.bottomAnchor.constraint(equalTo: bottomAnchor),
            sceneView.leadingAnchor.constraint(equalTo: leadingAnchor),
            sceneView.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        clipsToBounds = true
    }

    // Deliberately no deinit. The controller owns the ARSession's lifecycle;
    // pausing or detaching it when the preview unmounts would stop a scan that
    // is still running, which is exactly what a user backgrounding the preview
    // does not expect.
}

@objc(ARScannerPreviewViewManager)
final class ARScannerPreviewViewManager: RCTViewManager {
    override static func requiresMainQueueSetup() -> Bool { true }
    override func view() -> UIView! { ARScannerPreviewView() }
}
