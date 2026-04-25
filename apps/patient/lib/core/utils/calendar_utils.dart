import 'package:add_2_calendar/add_2_calendar.dart';

Future<void> addEventToCalendar({
  required String title,
  required String description,
  required DateTime startDate,
  required DateTime endDate,
  String location = '',
}) async {
  final event = Event(
    title: title,
    description: description,
    location: location,
    startDate: startDate,
    endDate: endDate,
    iosParams: const IOSParams(reminder: Duration(minutes: 30)),
    androidParams: const AndroidParams(emailInvites: []),
  );

  await Add2Calendar.addEvent2Cal(event);
}
