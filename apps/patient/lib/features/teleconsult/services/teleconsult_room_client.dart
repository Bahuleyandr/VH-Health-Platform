import 'package:flutter/material.dart';
import 'package:livekit_client/livekit_client.dart' as lk;
import 'package:vhhealth/features/teleconsult/models/teleconsult_models.dart';

abstract class TeleconsultRoomClient {
  Future<TeleconsultRoomSession> connect({
    required TeleconsultToken token,
    required bool publishVideo,
  });
}

abstract class TeleconsultRoomSession extends ChangeNotifier {
  bool get microphoneEnabled;
  bool get cameraEnabled;
  bool get connected;

  Future<void> setMicrophoneEnabled(bool enabled);
  Future<void> setCameraEnabled(bool enabled);
  Future<void> switchToAudioOnly();
  Future<void> disconnect();

  Widget buildRemoteVideo(BuildContext context);
  Widget buildLocalVideo(BuildContext context);
}

class LiveKitTeleconsultRoomClient implements TeleconsultRoomClient {
  const LiveKitTeleconsultRoomClient();

  @override
  Future<TeleconsultRoomSession> connect({
    required TeleconsultToken token,
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
    return LiveKitTeleconsultRoomSession(room);
  }
}

class LiveKitTeleconsultRoomSession extends TeleconsultRoomSession {
  LiveKitTeleconsultRoomSession(this._room) {
    _listener = _room.createListener()
      ..on<lk.RoomConnectedEvent>((_) {
        _connected = true;
        notifyListeners();
      })
      ..on<lk.RoomDisconnectedEvent>((_) {
        _connected = false;
        notifyListeners();
      })
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
  bool _connected = false;

  @override
  bool get microphoneEnabled => _microphoneEnabled;

  @override
  bool get cameraEnabled => _cameraEnabled;

  @override
  bool get connected => _connected;

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
  Future<void> switchToAudioOnly() async {
    await setCameraEnabled(false);
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
      return _VideoPlaceholder(
        icon: Icons.person_outline,
        label: MaterialLocalizations.of(context).alertDialogLabel,
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
        label: '',
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
  const _VideoPlaceholder({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.onSurfaceVariant;
    return ColoredBox(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Center(
        child: Icon(icon, color: color, size: 36, semanticLabel: label),
      ),
    );
  }
}

@visibleForTesting
class FakeTeleconsultRoomSession extends TeleconsultRoomSession {
  FakeTeleconsultRoomSession({this.connectedInitially = true}) {
    _connected = connectedInitially;
  }

  final bool connectedInitially;
  bool _microphoneEnabled = true;
  bool _cameraEnabled = true;
  bool _connected = false;

  @override
  bool get microphoneEnabled => _microphoneEnabled;

  @override
  bool get cameraEnabled => _cameraEnabled;

  @override
  bool get connected => _connected;

  @override
  Future<void> disconnect() async {
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
  Future<void> switchToAudioOnly() async {
    await setCameraEnabled(false);
  }

  @override
  Widget buildLocalVideo(BuildContext context) =>
      const ColoredBox(color: Colors.black12);

  @override
  Widget buildRemoteVideo(BuildContext context) =>
      const ColoredBox(color: Colors.black26);
}
