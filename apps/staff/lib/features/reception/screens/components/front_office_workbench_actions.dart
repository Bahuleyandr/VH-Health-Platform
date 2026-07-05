// ignore_for_file: invalid_use_of_protected_member

part of '../front_office_workbench_screen.dart';

extension _FrontOfficeWorkbenchActions on _FrontOfficeWorkbenchScreenState {
  Future<void> _loadInitialState() async {
    final role = StaffRole.fromString(await ApiConfig.getRole());
    final initialPatient = frontOfficeInitialPatientFromQuery(
      patientUid: widget.initialPatientUid,
      patientId: widget.initialPatientId,
      patientName: widget.initialPatientName,
      patientPhone: widget.initialPatientPhone,
      hospitalNumber: widget.initialHospitalNumber,
    );
    if (!mounted) return;
    setState(() {
      _role = role;
      _roleLoaded = true;
      _loading = false;
      if (initialPatient != null) {
        _selectedPatient = initialPatient;
        _searchCtrl.text = _patientLabel(initialPatient);
      }
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _canPatientLookup) _searchFocus.requestFocus();
    });

    if (initialPatient != null) {
      await _loadInvoicesFor(initialPatient);
      if (!mounted) return;
    }
    await _requestWorklistsForMode(appDeviceModeForContext(context));
  }

  Future<void> _requestWorklistsForMode(
    AppDeviceMode mode, {
    bool force = false,
  }) async {
    if (!frontOfficeWorkbenchShouldRequestWorklists(
      roleLoaded: _roleLoaded,
      role: _role,
      mode: mode,
      loadedForMode: _worklistsLoadedForMode,
      loadInFlight: _worklistsLoadInFlight,
      force: force,
    )) {
      if (mounted &&
          _loading &&
          !frontOfficeWorkbenchCanLoad(role: _role, mode: mode)) {
        setState(() => _loading = false);
      }
      return;
    }

    _worklistsLoadInFlight = true;
    try {
      await _loadWorklists();
      if (mounted && _error == null) {
        _worklistsLoadedForMode = mode;
      }
    } finally {
      _worklistsLoadInFlight = false;
    }
  }

  Future<void> _refreshWorklists() async {
    await _requestWorklistsForMode(
      appDeviceModeForContext(context),
      force: true,
    );
  }

  Future<void> _loadWorklists() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final queueFuture = switch (_queueScope) {
        FrontOfficeQueueScope.full ||
        FrontOfficeQueueScope.mine => _loadAppointmentQueueForSelectedDate(),
        FrontOfficeQueueScope.none => Future<List<dynamic>>.value(const []),
      };
      final admissionHandoffFuture = _canViewAdmissionHandoffs
          ? ScheduleApiService.getAdmissionAdviceQueue(limit: 12)
          : Future<List<Map<String, dynamic>>>.value(const []);
      final results = await Future.wait<dynamic>([
        queueFuture,
        MedicalApiService.getActiveAdmissions(limit: 12),
        admissionHandoffFuture,
      ]);
      if (!mounted) return;
      setState(() {
        _todayQueue = _mapList(results[0]);
        _activeAdmissions = _admissionList(results[1]);
        _activeAdmissionsTotal = _admissionTotal(results[1]);
        _admissionHandoffs = _mapList(results[2]);
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = localizedApiErrorFromRaw(AppStrings.of(context), e);
        _loading = false;
      });
    }
  }

  Future<List<dynamic>> _loadAppointmentQueueForSelectedDate() async {
    final doctorId = _queueScope == FrontOfficeQueueScope.mine
        ? await ApiConfig.getStaffId()
        : null;
    final data = await ScheduleApiService.getAppointments(
      doctorId: doctorId,
      date: _dateParam(_queueDate),
      page: 1,
      limit: 100,
    );
    return _mapList(data)
        .where((row) => _appointmentStatus(row) != 'CANCELLED')
        .toList(growable: false);
  }

  Future<void> _setQueueDate(DateTime value) async {
    final next = _dateOnly(value);
    if (_queueDate == next) return;
    setState(() => _queueDate = next);
    await _refreshWorklists();
  }

  void _scrollTo(GlobalKey key) {
    final target = key.currentContext;
    if (target == null) return;
    Scrollable.ensureVisible(
      target,
      duration: const Duration(milliseconds: 240),
      curve: Curves.easeOutCubic,
      alignment: 0.05,
    );
  }

  Future<List<Map<String, dynamic>>> _doctorOptionsFuture() {
    _doctorsFuture ??= ScheduleApiService.getAppointmentDoctors();
    return _doctorsFuture!;
  }

  Future<List<Map<String, dynamic>>> _wardOptionsFuture() {
    _wardsFuture ??= MedicalApiService.getAdmissionWardOptions();
    return _wardsFuture!;
  }

  String? _patientDialogInitialPhone() {
    final raw = _searchCtrl.text.trim();
    final digits = _digitsOnly(raw);
    if (digits.length >= 10 && RegExp(r'^[\d\s()+.-]+$').hasMatch(raw)) {
      return raw;
    }
    return null;
  }

  List<Map<String, dynamic>> _mapList(dynamic value) {
    if (value is Map) {
      value =
          value['appointments'] ??
          value['queue'] ??
          value['data'] ??
          value['items'] ??
          value['rows'];
    }
    if (value is! List) return const [];
    return value
        .whereType<Map>()
        .map((row) => Map<String, dynamic>.from(row))
        .toList();
  }

  List<Map<String, dynamic>> _admissionList(dynamic data) {
    dynamic value = data;
    if (value is Map) {
      value = value['admissions'] ?? value['data'] ?? value['items'];
      if (value is Map) {
        value = value['admissions'] ?? value['data'] ?? value['items'];
      }
    }
    return _mapList(value);
  }

  int _admissionTotal(dynamic data) {
    return frontOfficeAdmissionTotalFrom(
      data,
      fallbackCount: _admissionList(data).length,
    );
  }

  void _queuePatientLookup(String value) {
    _searchDebounce?.cancel();
    final query = value.trim();
    final selected = _selectedPatient;
    final selectedChanged =
        selected != null && query != _patientLabel(selected);
    final lookupReady = frontOfficeLookupQueryReady(query);
    setState(() {
      if (selectedChanged) {
        _selectedPatient = null;
        _patientInvoices = const [];
      }
      if (!lookupReady) {
        _patientMatches = const [];
        _lookupBusy = false;
        _lookupError = null;
      } else {
        _lookupBusy = true;
        _lookupError = null;
      }
    });
    if (!lookupReady) return;
    _searchDebounce = Timer(
      const Duration(milliseconds: 280),
      () => _searchPatients(value),
    );
  }

  Future<List<Map<String, dynamic>>> _searchPatients(String value) async {
    final query = value.trim();
    if (!frontOfficeLookupQueryReady(query)) {
      setState(() {
        _patientMatches = const [];
        _lookupBusy = false;
        _lookupError = null;
      });
      return const [];
    }
    setState(() {
      _lookupBusy = true;
      _lookupError = null;
    });
    try {
      final matches = (await PatientApiService.search(query, limit: 12))
          .where(
            (patient) => frontOfficePatientMatchesLookupQuery(patient, query),
          )
          .toList(growable: false);
      if (!mounted || _searchCtrl.text.trim() != query) return const [];
      setState(() {
        _patientMatches = matches;
        _lookupBusy = false;
      });
      return matches;
    } catch (e) {
      if (!mounted || _searchCtrl.text.trim() != query) return const [];
      setState(() {
        _lookupError = localizedApiErrorFromRaw(AppStrings.of(context), e);
        _lookupBusy = false;
      });
      return const [];
    }
  }

  Future<void> _handlePatientSearchSubmitted(String value) async {
    final query = value.trim();
    final currentMatch = _bestPatientLookupMatch(_patientMatches, query);
    if (currentMatch != null) {
      await _selectPatient(currentMatch);
      return;
    }

    final matches = await _searchPatients(query);
    if (!mounted) return;
    final loadedMatch = _bestPatientLookupMatch(matches, query);
    if (loadedMatch != null) await _selectPatient(loadedMatch);
  }

  Future<void> _selectPatient(Map<String, dynamic> patient) async {
    setState(() {
      _selectedPatient = patient;
      _patientMatches = const [];
      _searchCtrl.text = _patientLabel(patient);
    });
    await _loadInvoicesFor(patient);
  }

  void _clearSelectedPatient() {
    _searchDebounce?.cancel();
    setState(() {
      _selectedPatient = null;
      _patientMatches = const [];
      _patientInvoices = const [];
      _lookupBusy = false;
      _lookupError = null;
      _searchCtrl.clear();
    });
    _searchFocus.requestFocus();
  }

  bool _queueRowMatchesSelectedPatient(Map<String, dynamic> row) {
    final selected = _selectedPatient;
    if (selected == null) return false;
    final patient = _patientFromQueueRow(row);
    if (patient == null) return false;

    final selectedUid = _text(selected['uid']);
    final patientUid = _text(patient['uid']);
    if (selectedUid.isNotEmpty && patientUid.isNotEmpty) {
      return selectedUid == patientUid;
    }

    final selectedId = _text(selected['id']);
    final patientId = _text(patient['id']);
    if (selectedId.isNotEmpty && patientId.isNotEmpty) {
      return selectedId == patientId;
    }

    final selectedPhone = _digitsOnly(_text(selected['phone']));
    final patientPhone = _digitsOnly(_text(patient['phone']));
    return selectedPhone.isNotEmpty && selectedPhone == patientPhone;
  }

  Future<Map<String, dynamic>> _resolveQueuePatient(
    Map<String, dynamic> queuePatient,
  ) async {
    if (_text(queuePatient['uid']).isNotEmpty) return queuePatient;

    final query = _patientAdmissionQuery(queuePatient);
    if (query.length < 2) return queuePatient;

    setState(() => _lookupBusy = true);
    try {
      final matches = await PatientApiService.search(query, limit: 6);
      return _bestQueuePatientMatch(matches, queuePatient) ?? queuePatient;
    } catch (_) {
      return queuePatient;
    } finally {
      if (mounted) setState(() => _lookupBusy = false);
    }
  }

  Future<void> _selectQueuePatient(Map<String, dynamic> row) async {
    final queuePatient = _patientFromQueueRow(row);
    if (queuePatient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.queue_row_has_no_patient_details',
          ),
        ),
      );
      return;
    }

    final selected = await _resolveQueuePatient(queuePatient);
    if (!mounted) return;
    await _selectPatient(selected);
    if (!mounted) return;

    final hasUid = _text(selected['uid']).isNotEmpty;
    final s = AppStrings.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          hasUid
              ? s.lookup(
                  's4.lib.front_office_workbench.patient_selected_from_queue',
                )
              : s.lookup(
                  's4.lib.front_office_workbench.queue_patient_selected_search_before_billing',
                ),
        ),
        backgroundColor: hasUid ? AppTheme.successGreen : null,
      ),
    );
  }

  Future<void> _startAdmissionFromAdvice(Map<String, dynamic> row) async {
    final advicePatient = frontOfficeAdmissionAdvicePatientFrom(row);
    if (advicePatient == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.advice_row_has_no_patient_details',
          ),
        ),
      );
      return;
    }

    final selected = await _resolveQueuePatient(advicePatient);
    if (!mounted) return;
    await _selectPatient(selected);
    if (!mounted) return;
    await _showIpAdmissionDialog(admissionAdvice: row);
  }

  Future<void> _openBillingForAdvice(Map<String, dynamic> row) async {
    final advicePatient = frontOfficeAdmissionAdvicePatientFrom(row);
    if (advicePatient == null) return;
    final selected = await _resolveQueuePatient(advicePatient);
    if (!mounted) return;
    await _selectPatient(selected);
    if (!mounted) return;
    context.push(_patientRoute('/billing-desk'));
  }

  Future<void> _showAdmissionAdviceDialog(Map<String, dynamic> row) async {
    final s = AppStrings.of(context);
    final patient = frontOfficeAdmissionAdvicePatientFrom(row);
    final doctor = _firstText([
      row['doctor_name'],
      row['doctorName'],
      row['consultant_name'],
      row['consultantName'],
    ]);
    final note = _admissionAdviceNote(row);
    final advisedAt = _admissionAdviceDate(row);
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const AppText('s4.lib.front_office_workbench.opd_to_ipd_advice'),
        content: SizedBox(
          width: 520,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (patient != null) _PatientCard(patient: patient, onTap: null),
              const SizedBox(height: 10),
              _DetailLine(
                label: s.lookup('s4.lib.front_office_workbench.doctor'),
                value: doctor,
              ),
              _DetailLine(
                label: s.lookup('s4.lib.front_office_workbench.advised_at'),
                value: advisedAt,
              ),
              _DetailLine(
                label: s.lookup('s4.lib.front_office_workbench.advice'),
                value: note,
              ),
              const SizedBox(height: 10),
              _InlineAlert(
                message: s.lookup(
                  's4.lib.front_office_workbench.admission_stays_pending_until_ready',
                ),
                color: AppTheme.warningAmber,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const AppText('action.close'),
          ),
          FilledButton.icon(
            onPressed: () {
              Navigator.pop(dialogContext);
              _startAdmissionFromAdvice(row);
            },
            icon: const Icon(Icons.local_hospital_outlined),
            label: const AppText(
              's4.lib.front_office_workbench.assign_ward_bed',
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _loadInvoicesFor(Map<String, dynamic>? patient) async {
    final uid = patient?['uid']?.toString();
    if (!_canBilling || uid == null || uid.isEmpty) {
      setState(() => _patientInvoices = const []);
      return;
    }
    setState(() => _invoiceBusy = true);
    try {
      final invoices = await BillingApiService.listInvoices(
        patientUid: uid,
        limit: 8,
      );
      if (!mounted) return;
      setState(() {
        _patientInvoices = invoices;
        _invoiceBusy = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _patientInvoices = const [];
        _invoiceBusy = false;
      });
    }
  }

  Future<void> _createDraftInvoice() async {
    final patient = _selectedPatient;
    final uid = patient?['uid']?.toString();
    if (!_canBilling || patient == null || uid == null || uid.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.select_a_patient_before_billing',
          ),
        ),
      );
      return;
    }
    if (_billingActionBusy) return;

    setState(() {
      _billingActionBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.createDraftInvoice(
        patientUid: uid,
        patientName: _text(patient['name']),
        patientPhone: _text(patient['phone']),
        invoiceType: 'OP',
        department: 'Front Office',
        notes: 'Front office OP draft invoice',
      );
      await _loadInvoicesFor(patient);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText(
            's4.lib.front_office_workbench.draft_op_invoice_created',
          ),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  Future<void> _issueInvoice(Map<String, dynamic> invoice) async {
    final id = _intFrom(invoice['id']);
    if (!_canBilling || id == null) return;
    if (_billingActionBusy) return;

    setState(() {
      _billingActionBusy = true;
      _error = null;
    });
    try {
      await BillingApiService.issueInvoice(id);
      await _loadInvoicesFor(_selectedPatient);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.billing_desk.invoice_issued'),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  Future<void> _collectInvoicePayment(Map<String, dynamic> invoice) async {
    if (!_canBilling || _billingActionBusy) return;
    setState(() {
      _billingActionBusy = true;
      _error = null;
    });
    try {
      final collected = await showBillingPaymentDialog(
        context: context,
        invoice: invoice,
      );
      if (!collected || !mounted) return;
      await _loadInvoicesFor(_selectedPatient);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: AppText('s4.lib.billing_desk.payment_collected'),
          backgroundColor: AppTheme.successGreen,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(
        () => _error = localizedApiErrorFromRaw(AppStrings.of(context), e),
      );
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  Future<void> _printInvoiceDocument(
    Map<String, dynamic> invoice,
    BillingDocumentType type,
  ) async {
    if (!_canBilling || _billingActionBusy) return;
    setState(() => _billingActionBusy = true);
    try {
      await printBillingDocument(
        context: context,
        invoice: invoice,
        type: type,
      );
    } finally {
      if (mounted) setState(() => _billingActionBusy = false);
    }
  }

  String _patientLabel(Map<String, dynamic> patient) {
    return patientSearchLabel(patient);
  }

  String? _selectedPatientUid() => _selectedPatient?['uid']?.toString();

  String _patientRoute(String path) {
    return frontOfficePatientScopedRoute(path, patient: _selectedPatient);
  }

  String _patientRecordsRoute() {
    return frontOfficePatientScopedRoute(
      '/patient-records',
      patient: _selectedPatient,
      queryParameters: const {'context': 'front-office'},
    );
  }

  String _patientRecordsUploadRoute() {
    return frontOfficePatientScopedRoute(
      '/patient-records',
      patient: _selectedPatient,
      queryParameters: const {'context': 'front-office', 'action': 'upload'},
    );
  }

  Future<List<Map<String, dynamic>>> _findPotentialDuplicatePatients({
    required String name,
    required String phone,
    String? birthday,
  }) async {
    final seen = <String>{};
    final candidates = <Map<String, dynamic>>[];

    Future<void> addMatches(String query) async {
      if (!frontOfficeLookupQueryReady(query)) return;
      final matches = await PatientApiService.search(query, limit: 8);
      for (final match in matches) {
        final key = _firstText([
          match['uid'],
          match['id'],
          match['hospital_number'],
          match['phone'],
          match['name'],
        ]);
        if (key.isEmpty || !seen.add(key)) continue;
        if (frontOfficePotentialDuplicatePatient(
          patient: match,
          name: name,
          phone: phone,
          birthday: birthday,
        )) {
          candidates.add(match);
        }
      }
    }

    await addMatches(phone);
    await addMatches(name);
    return candidates;
  }
}
