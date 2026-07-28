// loro-syscap — capture the computer's system audio to a WAV file, via
// ScreenCaptureKit (macOS 13+). No virtual audio driver, no Audio MIDI setup:
// the OS shows a single Screen Recording permission prompt on first run.
//
// Usage:   loro-syscap <output.wav>
// Stops cleanly on SIGINT/SIGTERM and finalizes the WAV. Our own process audio
// is excluded so the app's own sounds are not recorded.
//
// Privacy (BR-1/BR-8): audio never leaves the machine; this tool only writes the
// local WAV path it was given and prints event-oriented status to stderr — no
// transcript content, no PII.

import AppKit
import AVFoundation
import ScreenCaptureKit

// stderr logging (stdout stays clean for any future machine-readable use)
func elog(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

@available(macOS 13.0, *)
final class Capturer: NSObject, SCStreamOutput {
    private let outputURL: URL
    private var stream: SCStream?
    private var file: AVAudioFile?
    private let queue = DispatchQueue(label: "loro.syscap.audio")

    init(output: URL) { self.outputURL = output }

    func start() async throws {
        // ScreenCaptureKit needs a display in the content filter even for an
        // audio-only capture. Pick the first available display.
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "loro-syscap", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no display available"])
        }
        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        // Minimal video config: SCK still runs a video pipeline; we add no video
        // output, so frames are produced-and-dropped cheaply.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
        elog("syscap: capturing system audio -> \(outputURL.path)")
    }

    func stop() async {
        if let stream = stream { try? await stream.stopCapture() }
        file = nil // flush/close
        elog("syscap: stopped")
    }

    // MARK: SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        do {
            try sampleBuffer.withAudioBufferList { abl, _ in
                guard let absd = sampleBuffer.formatDescription?.audioStreamBasicDescription,
                      let fmt = AVAudioFormat(standardFormatWithSampleRate: absd.mSampleRate,
                                              channels: absd.mChannelsPerFrame),
                      let pcm = AVAudioPCMBuffer(pcmFormat: fmt, bufferListNoCopy: abl.unsafePointer)
                else { return }
                if file == nil {
                    // Match the incoming format; transcribe step downsamples to
                    // 16k mono via ffmpeg, so we keep the native 48k float WAV.
                    file = try AVAudioFile(forWriting: outputURL, settings: fmt.settings,
                                           commonFormat: .pcmFormatFloat32, interleaved: false)
                }
                try file?.write(from: pcm)
            }
        } catch {
            elog("syscap: write error: \(error.localizedDescription)")
        }
    }
}

// ---- entrypoint ----
let args = CommandLine.arguments
guard args.count >= 2 else {
    elog("usage: loro-syscap <output.wav>")
    exit(2)
}
let outputURL = URL(fileURLWithPath: args[1])

guard #available(macOS 13.0, *) else {
    elog("syscap: requires macOS 13 or newer")
    exit(3)
}

let capturer = Capturer(output: outputURL)

// graceful stop on SIGINT/SIGTERM: stop the stream, finalize the file, exit 0
func installSignalHandler(_ sig: Int32) -> DispatchSourceSignal {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler {
        Task {
            await capturer.stop()
            exit(0)
        }
    }
    src.resume()
    return src
}
let sigint = installSignalHandler(SIGINT)
let sigterm = installSignalHandler(SIGTERM)
_ = (sigint, sigterm) // keep alive

// The parent (Loro) signals a clean stop by closing our stdin. Watch for EOF and
// finalize the WAV — more portable than relying on a specific signal.
DispatchQueue.global(qos: .utility).async {
    while true {
        let data = FileHandle.standardInput.availableData
        if data.isEmpty { // EOF: stdin closed
            DispatchQueue.main.async {
                Task { await capturer.stop(); exit(0) }
            }
            return
        }
    }
}

Task {
    do {
        try await capturer.start()
    } catch {
        let msg = error.localizedDescription
        elog("syscap: start failed: \(msg)")
        // TCC denial: point the user at the exact permission and open the pane.
        if msg.lowercased().contains("tcc") || msg.lowercased().contains("screen")
            || msg.lowercased().contains("captura de tela") {
            elog("syscap: grant Screen Recording permission in System Settings > "
                + "Privacy & Security > Screen Recording, then run again")
            let url = "x-apple.systempreferences:com.apple.preference.security"
                + "?Privacy_ScreenCapture"
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
            exit(4) // distinct code so callers can show a permission hint
        }
        exit(1)
    }
}

// keep the process alive until a signal arrives
RunLoop.main.run()
