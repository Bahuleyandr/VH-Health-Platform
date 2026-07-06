import 'package:flutter/material.dart';
import 'package:livekit_client/livekit_client.dart' as lk;

import '../../../l10n/app_strings.dart';
import '../models/staff_teleconsult_models.dart';

abstract class StaffTeleconsultRoomClient {
  Future<StaffTeleconsultRoomSession> connect({
    required StaffTeleconsultToken token,
    required bool publishVideo,
  });
}

abstract class StaffTeleconsultRoomSession extends ChangeNotifier {
  bool get microphoneEnabled;
  bool get cameraEnabled;
  bool get screenShareEnabled;
  bool get connected;
  int get participantCount;

  Future<void> setMicrophoneEnabled(bool enabled);
  Future<void> setCameraEnabled(bool enabled);
  Future<void> setScreenShareEnabled(bool enabled);
  Future<void> disconnect();

  Widget buildRemoteVideo(BuildContext context);
  Widget buildLocalVideo(BuildContext context);
}

class LiveKitStaffTeleconsultRoomClient implements StaffTeleconsultRoomClient {
  const LiveKitStaffTeleconsultRoomClient();

  @override
  Future<StaffTeleconsultRoomSession> connect({
    required StaffTeleconsultToken token,
    required bool publishVideo,
  }) async {
    final room = lk.Room(
      roomOptions: const lk.RoomOptions(adaptiveStream: true, dynacast: true),
    );
    await room.connect(
      token.serverUrl,
      token.participantToken,
      connectOptions: const lk.ConnectOptions(autoSubscribe: true),
    );
    await room.localParticipant?.setMicrophoneEnabled(true);
    await room.localParticipant?.setCameraEnabled(publishVideo);
    return LiveKitStaffTeleconsultRoomSession(room);
  }
}

class LiveKitStaffTeleconsultRoomSession extends StaffTeleconsultRoomSession {
  LiveKitStaffTeleconsultRoomSession(this._room) {
    _listener = _room.createListener()
      ..on<lk.RoomConnectedEvent>((_) {
        _connected = true;
        notifyListeners();
      })
      ..on<lk.RoomDisconnectedEvent>((_) {
        _connected = false;
        notifyListeners();
      })
      ..on<lk.ParticipantConnectedEvent>((_) => notifyListeners())
      ..on<lk.ParticipantDisconnectedEvent>((_) => notifyListeners())
      ..on<lk.TrackSubscribedEvent>((_) => notifyListeners())
      ..on<lk.TrackUnsubscribedEvent>((_) => notifyListeners())
      ..on<lk.TrackMutedEvent>((_) => notifyListeners())
      ..on<lk.TrackUnmutedEvent>((_) => notifyListeners());
    _connected = true;
  }

  final lk.Room _room;
  late final lk.EventsListener<lk.RoomEvent> _listener;
  bool _microphoneEnabled = true;
  bool _cameraEnabled = true;
  bool _screenShareEnabled = false;
  bool _connected = false;

  @override
  bool get microphoneEnabled => _microphoneEnabled;

  @override
  bool get cameraEnabled => _cameraEnabled;

  @override
  bool get screenShareEnabled => _screenShareEnabled;

  @override
  bool get connected => _connected;

  @override
  int get participantCount => 1 + _room.remoteParticipants.length;

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    await _room.localParticipant?.setMicrophoneEnabled(enabled);
    _microphoneEnabled = enabled;
    notifyListeners();
  }

  @override
  Future<void> setCameraEnabled(bool enabled) async {
    await _room.localParticipant?.setCameraEnabled(enabled);
    _cameraEnabled = enabled;
    notifyListeners();
  }

  @override
  Future<void> setScreenShareEnabled(bool enabled) async {
    if (enabled) {
      await _room.localParticipant?.setScreenShareEnabled(true);
    } else {
      await _room.localParticipant?.setScreenShareEnabled(false);
    }
    _screenShareEnabled = enabled;
    notifyListeners();
  }

  @override
  Future<void> disconnect() async {
    _connected = false;
    notifyListeners();
    await _room.disconnect();
  }

  @override
  Widget buildRemoteVideo(BuildContext context) {
    final track = _firstRemoteVideoTrack();
    if (track == null) {
      return const _VideoPlaceholder(
        icon: Icons.person_outline,
        labelKey: 'staff_teleconsult.remote_video',
      );
    }
    return lk.VideoTrackRenderer(track, fit: lk.VideoViewFit.cover);
  }

  @override
  Widget buildLocalVideo(BuildContext context) {
    final track = _firstLocalVideoTrack();
    if (track == null || !_cameraEnabled) {
      return const _VideoPlaceholder(
        icon: Icons.videocam_off_outlined,
        labelKey: 'staff_teleconsult.local_video',
      );
    }
    return lk.VideoTrackRenderer(track, fit: lk.VideoViewFit.cover);
  }

  lk.VideoTrack? _firstLocalVideoTrack() {
    final participant = _room.localParticipant;
    if (participant == null) return null;
    for (final publication in participant.videoTrackPublications) {
      final track = publication.track;
      if (track is lk.VideoTrack) return track;
    }
    return null;
  }

  lk.VideoTrack? _firstRemoteVideoTrack() {
    for (final participant in _room.remoteParticipants.values) {
      for (final publication in participant.videoTrackPublications) {
        final track = publication.track;
        if (track is lk.VideoTrack) return track;
      }
    }
    return null;
  }

  @override
  void dispose() {
    _listener.dispose();
    _room.dispose();
    super.dispose();
  }
}

class _VideoPlaceholder extends StatelessWidget {
  const _VideoPlaceholder({required this.icon, required this.labelKey});

  final IconData icon;
  final String labelKey;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    final label = AppStrings.of(context).lookup(labelKey);
    return ColoredBox(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Center(
        child: Icon(icon, color: color, size: 36, semanticLabel: label),
      ),
    );
  }
}

@visibleForTesting
class FakeStaffTeleconsultRoomSession extends StaffTeleconsultRoomSession {
  FakeStaffTeleconsultRoomSession({
    this.connectedInitially = true,
    this.initialParticipantCount = 2,
  }) {
    _connected = connectedInitially;
  }

  final bool connectedInitially;
  final int initialParticipantCount;
  bool _microphoneEnabled = true;
  bool _cameraEnabled = true;
  bool _screenShareEnabled = false;
  bool _connected = false;
  int disconnectCount = 0;

  @override
  bool get microphoneEnabled => _microphoneEnabled;

  @override
  bool get cameraEnabled => _cameraEnabled;

  @override
  bool get screenShareEnabled => _screenShareEnabled;

  @override
  bool get connected => _connected;

  @override
  int get participantCount => initialParticipantCount;

  @override
  Future<void> disconnect() async {
    disconnectCount += 1;
    _connected = false;
    notifyListeners();
  }

  @override
  Future<void> setCameraEnabled(bool enabled) async {
    _cameraEnabled = enabled;
    notifyListeners();
  }

  @override
  Future<void> setMicrophoneEnabled(bool enabled) async {
    _microphoneEnabled = enabled;
    notifyListeners();
  }

  @override
  Future<void> setScreenShareEnabled(bool enabled) async {
    _screenShareEnabled = enabled;
    notifyListeners();
  }

  @override
  Widget buildLocalVideo(BuildContext context) =>
      const ColoredBox(color: Colors.black12);

  @override
  Widget buildRemoteVideo(BuildContext context) =>
      const ColoredBox(color: Colors.black26);
}
