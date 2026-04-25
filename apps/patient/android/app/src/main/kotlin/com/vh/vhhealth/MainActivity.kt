package com.vh.vhhealth

import io.flutter.embedding.android.FlutterFragmentActivity

// FlutterFragmentActivity extends androidx.fragment.app.FragmentActivity, which
// extends androidx.activity.ComponentActivity. Several plugins (local_auth,
// health, image_picker, etc.) call registerForActivityResult on the host
// activity, which is a ComponentActivity API — the plain FlutterActivity is a
// raw android.app.Activity and the cast in GeneratedPluginRegistrant fails
// with ClassCastException at runtime, blocking the Flutter view from ever
// attaching a focused window (observed as an ANR on first launch).
class MainActivity : FlutterFragmentActivity()
