#include "flutter_window.h"

#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>

#include <memory>
#include <optional>

#include "flutter/generated_plugin_registrant.h"

namespace {

// MethodChannel name shared with the Dart side
// (apps/staff/lib/core/services/windows_screen_capture.dart).
constexpr char kScreenCaptureChannel[] =
    "vhhealth/screen_protector_windows";

// SetWindowDisplayAffinity / WDA_EXCLUDEFROMCAPTURE are declared in winuser.h
// (pulled in via windows.h from flutter headers). WDA_EXCLUDEFROMCAPTURE
// (0x11) requires Windows 10 2004+; on older builds the call fails and we
// fall back to WDA_MONITOR (0x01), which still blocks most capture paths.
#ifndef WDA_NONE
#define WDA_NONE 0x00000000
#endif
#ifndef WDA_MONITOR
#define WDA_MONITOR 0x00000001
#endif
#ifndef WDA_EXCLUDEFROMCAPTURE
#define WDA_EXCLUDEFROMCAPTURE 0x00000011
#endif

// Apply (or clear) capture exclusion on |hwnd|. Returns the affinity that was
// actually set, or -1 if every attempt failed.
int ApplyCaptureExclusion(HWND hwnd, bool enable) {
  if (hwnd == nullptr) {
    return -1;
  }
  if (!enable) {
    return ::SetWindowDisplayAffinity(hwnd, WDA_NONE) ? WDA_NONE : -1;
  }
  if (::SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)) {
    return WDA_EXCLUDEFROMCAPTURE;
  }
  // Older Windows 10 builds reject WDA_EXCLUDEFROMCAPTURE — degrade to
  // WDA_MONITOR, which blanks the window in screenshots / screen shares.
  if (::SetWindowDisplayAffinity(hwnd, WDA_MONITOR)) {
    return WDA_MONITOR;
  }
  return -1;
}

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  // STF-1 (audit 2026-06-18): the cross-platform `screen_protector` plugin has
  // no Windows implementation, so the PHI workbench was fully screenshot-able
  // on Windows desktops. Register a method channel the Dart side calls to
  // exclude the top-level window from screen capture via
  // SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE).
  screen_capture_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), kScreenCaptureChannel,
          &flutter::StandardMethodCodec::GetInstance());
  screen_capture_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        const std::string& method = call.method_name();
        if (method == "enableCaptureProtection" ||
            method == "disableCaptureProtection") {
          const bool enable = method == "enableCaptureProtection";
          // GetHandle() is the top-level Win32Window (the Flutter view is a
          // child set via SetChildContent); display affinity must target the
          // top-level window.
          const int applied = ApplyCaptureExclusion(GetHandle(), enable);
          if (applied >= 0) {
            result->Success(flutter::EncodableValue(applied));
          } else {
            result->Error("affinity_failed",
                          "SetWindowDisplayAffinity failed");
          }
        } else {
          result->NotImplemented();
        }
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
