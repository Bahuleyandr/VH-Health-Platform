// Attachment saving is platform-split (STF-6):
//  * io platforms (Android/iOS/Windows/Linux/macOS) write the bytes under
//    the downloads directory and open the file externally;
//  * web cannot touch dart:io at runtime — the previous implementation
//    compiled under dart2js but threw on the first download tap, so the
//    staff-web build could never save an attachment. The web variant hands
//    the bytes to the browser as a Blob download instead.
//
// `savedPath` is null on web: the browser owns where the download lands.
export 'attachment_saver_io.dart'
    if (dart.library.js_interop) 'attachment_saver_web.dart';
