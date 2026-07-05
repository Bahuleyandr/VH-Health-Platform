part of '../front_office_workbench_screen.dart';

extension _FrontOfficeWorkbenchSections on _FrontOfficeWorkbenchScreenState {
  Widget _buildHeader(AppDeviceMode mode) {
    final s = AppStrings.of(context);
    return _Surface(
      child: Wrap(
        spacing: 12,
        runSpacing: 12,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              color: AppTheme.primaryBlue.withValues(alpha: 0.14),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(
              Icons.space_dashboard_outlined,
              color: AppTheme.primaryBlue,
            ),
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 220, maxWidth: 520),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AppText(
                  's4.lib.front_office_workbench.front_office_workbench',
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                ),
                Text(
                  s.lookup(_role.displayNameKey),
                  style: TextStyle(color: AppTheme.textSecondary),
                ),
              ],
            ),
          ),
          _Metric(
            icon: Icons.event_available,
            label: s.frontOfficeQueueTodayOp,
            value: '${_todayQueue.length}',
            color: AppTheme.primaryTeal,
            onTap: () => _scrollTo(_queuePanelKey),
          ),
          _Metric(
            icon: Icons.local_hospital,
            label: s.lookup(
              's4.lib.front_office_workbench.active_ip_admissions',
            ),
            value: '$_activeAdmissionsTotal',
            color: AppTheme.primaryBlue,
            onTap: () => _scrollTo(_admissionsPanelKey),
          ),
          if (_canViewAdmissionHandoffs)
            _Metric(
              icon: Icons.move_down_outlined,
              label: s.lookup('s4.lib.front_office_workbench.opd_ipd_handoff'),
              value: '${_admissionHandoffs.length}',
              color: AppTheme.warningAmber,
              onTap: () => _scrollTo(_admissionsPanelKey),
            ),
          Chip(
            avatar: const Icon(Icons.devices_outlined, size: 18),
            label: Text(mode.apiValue.toUpperCase()),
          ),
          if (_canBookOp)
            FilledButton.icon(
              onPressed: _showOpBookingDialog,
              icon: const Icon(Icons.event_available_outlined),
              label: const AppText(
                's4.lib.front_office_workbench.book_op_appointment',
              ),
            ),
          IconButton.filledTonal(
            tooltip: AppStrings.of(context).lookup('action.refresh'),
            onPressed: _refreshWorklists,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
    );
  }

  Widget _buildPatientContextStrip(Map<String, dynamic> patient) {
    final s = AppStrings.of(context);
    final appointments = _todayQueue
        .where(_queueRowMatchesSelectedPatient)
        .toList(growable: false);
    final invoiceDue = _patientInvoices.fold<num>(
      0,
      (total, invoice) => total + billingInvoiceAmountDue(invoice),
    );
    final demographics = [
      patientHospitalNumberFrom(patient),
      patientNameFrom(patient),
      patientPhoneFrom(patient),
      [
        patientAgeFrom(patient).isEmpty ? null : '${patientAgeFrom(patient)}y',
        patientGenderFrom(patient),
      ].whereType<String>().where((value) => value.isNotEmpty).join('/'),
    ].where((value) => value.isNotEmpty).join(' | ');

    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                backgroundColor: AppTheme.primaryTeal.withValues(alpha: 0.14),
                child: const Icon(Icons.person_pin_outlined),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      patientNameFrom(patient),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    if (demographics.isNotEmpty)
                      Text(
                        demographics,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                  ],
                ),
              ),
              TextButton.icon(
                onPressed: _clearSelectedPatient,
                icon: const Icon(Icons.close),
                label: const AppText('investigations.clear_file'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _InfoPill(
                icon: Icons.event_available_outlined,
                label: _frontOfficeOpAppointmentsTodayLabel(
                  s,
                  appointments.length,
                ),
                color: AppTheme.primaryTeal,
              ),
              _InfoPill(
                icon: Icons.receipt_long_outlined,
                label: _patientInvoices.isEmpty
                    ? s.lookup('s4.lib.front_office_workbench.no_bills_loaded')
                    : _frontOfficeBillsDueLabel(
                        s,
                        _patientInvoices.length,
                        _money(invoiceDue),
                      ),
                color: AppTheme.primaryBlue,
              ),
              _InfoPill(
                icon: Icons.folder_shared_outlined,
                label: s.lookup(
                  's4.lib.front_office_workbench.front_office_summary_only',
                ),
                color: AppTheme.warningAmber,
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (_canBookOp)
                FilledButton.icon(
                  onPressed: _showOpBookingDialog,
                  icon: const Icon(Icons.event_available_outlined),
                  label: const AppText('s4.lib.appointments.book_op'),
                ),
              if (_canBookOp)
                OutlinedButton.icon(
                  onPressed: _showWalkInRegistrationDialog,
                  icon: const Icon(Icons.how_to_reg_outlined),
                  label: const AppText('appt_queue.register_walk_in'),
                ),
              if (_canBilling)
                OutlinedButton.icon(
                  onPressed: _billingActionBusy ? null : _createDraftInvoice,
                  icon: const Icon(Icons.receipt_long_outlined),
                  label: const AppText(
                    's4.lib.front_office_workbench.draft_bill',
                  ),
                ),
              OutlinedButton.icon(
                onPressed: () => context.push(_patientRecordsUploadRoute()),
                icon: const Icon(Icons.upload_file),
                label: const AppText(
                  's4.lib.patient_records.upload_prior_record',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildUnavailablePanel({
    required IconData icon,
    required String title,
    required String message,
    List<Widget> actions = const [],
  }) {
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(icon: icon, title: title),
          const SizedBox(height: 8),
          Text(message, style: TextStyle(color: AppTheme.textSecondary)),
          if (actions.isNotEmpty) ...[
            const SizedBox(height: 14),
            Wrap(spacing: 10, runSpacing: 10, children: actions),
          ],
        ],
      ),
    );
  }

  Widget _buildPatientPanel() {
    final s = AppStrings.of(context);
    final selected = _selectedPatient;
    final createOffer = frontOfficeShouldOfferPatientCreate(
      role: _role,
      query: _searchCtrl.text,
      lookupBusy: _lookupBusy,
      hasSelectedPatient: selected != null,
      matchCount: _patientMatches.length,
    );
    final phoneLikeQuery = _frontOfficePhoneLikeQuery(_searchCtrl.text);
    final shortPhoneQuery =
        phoneLikeQuery && !frontOfficePhoneMeetsMinimum(_searchCtrl.text);
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.manage_search,
            title: s.lookup('bed_sheet.section.patient'),
            trailing: Wrap(
              spacing: 8,
              children: [
                if (selected != null && _canPatientRegistryWrite)
                  IconButton.filledTonal(
                    tooltip: AppStrings.of(
                      context,
                    ).lookup('s4.lib.front_office_workbench.edit_patient'),
                    onPressed: () => _showPatientDialog(patient: selected),
                    icon: const Icon(Icons.edit_outlined),
                  ),
                if (_canPatientRegistryCreate)
                  FilledButton.icon(
                    onPressed: () => _showPatientDialog(
                      initialPhone: _patientDialogInitialPhone(),
                    ),
                    icon: const Icon(Icons.person_add_alt_1),
                    label: const AppText(
                      's4.lib.front_office_workbench.new_patient',
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          if (_canPatientLookup) ...[
            Row(
              children: [
                Expanded(
                  child: Focus(
                    onKeyEvent: (node, event) {
                      if (event is KeyDownEvent &&
                          event.logicalKey == LogicalKeyboardKey.escape) {
                        _clearSelectedPatient();
                        return KeyEventResult.handled;
                      }
                      return KeyEventResult.ignored;
                    },
                    child: TextField(
                      controller: _searchCtrl,
                      focusNode: _searchFocus,
                      onChanged: _queuePatientLookup,
                      onSubmitted: _handlePatientSearchSubmitted,
                      decoration: InputDecoration(
                        labelText: AppStrings.of(
                          context,
                        ).lookup('reception_counter.patient_lookup.hint'),
                        prefixIcon: const Icon(Icons.search),
                        suffixIcon: _lookupBusy
                            ? const Padding(
                                padding: EdgeInsets.all(12),
                                child: SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                              )
                            : null,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                IconButton.filledTonal(
                  tooltip: AppStrings.of(context).lookup('action.search'),
                  onPressed: () => _searchPatients(_searchCtrl.text),
                  icon: const Icon(Icons.search),
                ),
              ],
            ),
            if (_lookupError != null) ...[
              const SizedBox(height: 8),
              Text(
                _lookupError!,
                style: TextStyle(color: AppTheme.errorOnSurface),
              ),
            ] else if (shortPhoneQuery) ...[
              const SizedBox(height: 8),
              AppText(
                's4.lib.front_office_workbench.enter_at_least_10_digits_to_search_or_create_by',
                style: TextStyle(color: AppTheme.textSecondary),
              ),
            ],
          ] else
            Text(
              s.format(
                's4.dynamic.front_office.patient_lookup_not_enabled_for_role',
                {'role': s.lookup(_role.displayNameKey)},
              ),
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          if (selected != null) ...[
            const SizedBox(height: 10),
            _PatientCard(patient: selected, selected: true, onTap: null),
          ],
          if (_patientMatches.isNotEmpty) ...[
            const SizedBox(height: 10),
            ..._patientMatches.map(
              (patient) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _PatientCard(
                  patient: patient,
                  onTap: () => _selectPatient(patient),
                ),
              ),
            ),
          ] else if (createOffer) ...[
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: () => _showPatientDialog(
                initialPhone: _patientDialogInitialPhone(),
              ),
              icon: const Icon(Icons.person_add_alt_1),
              label: const AppText(
                's4.lib.front_office_workbench.create_new_patient',
              ),
            ),
          ] else if (!_canPatientRegistryCreate &&
              !_lookupBusy &&
              _patientMatches.isEmpty &&
              selected == null &&
              frontOfficeLookupQueryReady(_searchCtrl.text)) ...[
            const SizedBox(height: 10),
            Text(
              s.format(
                's4.dynamic.front_office.no_patient_found_read_only_role',
                {'role': s.lookup(_role.displayNameKey)},
              ),
              style: TextStyle(color: AppTheme.textSecondary),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildActionPanel() {
    final s = AppStrings.of(context);
    final hasPatient = _selectedPatientUid() != null;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.apps_outlined,
            title: s.lookup('s4.lib.front_office_workbench.workflows'),
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 10,
            runSpacing: 10,
            children: [
              if (_canBookOp)
                _ActionTile(
                  icon: Icons.calendar_month,
                  label: s.lookup(
                    's4.lib.front_office_workbench.book_op_appointment',
                  ),
                  color: AppTheme.accentCyan,
                  onTap: _showOpBookingDialog,
                ),
              if (_canBookOp)
                _ActionTile(
                  icon: Icons.event_note_outlined,
                  label: s.lookup('s4.lib.front_office_workbench.appointments'),
                  color: AppTheme.primaryBlue,
                  onTap: () => context.push('/appointments'),
                ),
              if (_canBookOp)
                _ActionTile(
                  icon: Icons.how_to_reg_outlined,
                  label: s.lookup('appt_queue.register_walk_in'),
                  color: AppTheme.primaryTeal,
                  enabled: hasPatient,
                  onTap: _showWalkInRegistrationDialog,
                ),
              if (_canAdmitIp)
                _ActionTile(
                  icon: Icons.local_hospital_outlined,
                  label: s.lookup('s4.lib.front_office_workbench.admit_ip'),
                  color: AppTheme.warningAmber,
                  enabled: hasPatient && !_admissionActionBusy,
                  onTap: () => _showIpAdmissionDialog(),
                ),
              if (_canAdmitIp)
                _ActionTile(
                  icon: Icons.local_hospital,
                  label: s.lookup('s4.lib.front_office_workbench.admissions'),
                  color: AppTheme.warningAmber,
                  onTap: () => context.push('/emr/admissions'),
                ),
              if (_canBilling)
                _ActionTile(
                  icon: Icons.receipt_long,
                  label: s.lookup('s4.lib.front_office_workbench.billing'),
                  color: AppTheme.primaryBlue,
                  onTap: () => context.push(_patientRoute('/billing-desk')),
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.folder_shared,
                  label: s.lookup('s4.lib.front_office_workbench.records'),
                  color: AppTheme.primaryTeal,
                  enabled: hasPatient,
                  onTap: () => context.push(_patientRecordsRoute()),
                ),
              if (_canClinical)
                _ActionTile(
                  icon: Icons.monitor_heart_outlined,
                  label: s.lookup('s4.lib.front_office_workbench.vitals'),
                  color: AppTheme.errorRed,
                  enabled: hasPatient,
                  onTap: () => context.push(_patientRoute('/vitals')),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildQueuePanel() {
    final s = AppStrings.of(context);
    final queueScope = _queueScope;
    final title = queueScope == FrontOfficeQueueScope.mine
        ? s.frontOfficeQueueMine(
            frontOfficeQueueDateLabelForStrings(s, _queueDate),
          )
        : frontOfficeQueueDateLabelForStrings(s, _queueDate);
    final dateParam = _dateParam(_queueDate);
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.event_note,
            title: title,
            trailing: Wrap(
              spacing: 8,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                TextButton.icon(
                  onPressed: () =>
                      context.push('/appointments?date=$dateParam'),
                  icon: const Icon(Icons.calendar_month_outlined),
                  label: const AppText('attendance.tab.calendar'),
                ),
                TextButton.icon(
                  onPressed: _refreshWorklists,
                  icon: const Icon(Icons.refresh),
                  label: const AppText('action.refresh'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          if (queueScope != FrontOfficeQueueScope.none) ...[
            _QueueDateSwitcher(
              selectedDate: _queueDate,
              onSelected: _setQueueDate,
            ),
            const SizedBox(height: 8),
          ],
          if (queueScope == FrontOfficeQueueScope.none)
            _EmptyLine(
              icon: Icons.lock_outline,
              text: s.lookup(
                's4.lib.front_office_workbench.op_queue_restricted_for_role',
              ),
            )
          else if (_todayQueue.isEmpty)
            _EmptyLine(
              icon: Icons.event_busy,
              text: s.lookup(
                's4.lib.front_office_workbench.no_appointments_queued_for_date',
              ),
            )
          else
            ..._todayQueue.take(5).map(_queueTile),
        ],
      ),
    );
  }

  Widget _queueTile(Map<String, dynamic> row) {
    final s = AppStrings.of(context);
    final id = _appointmentId(row);
    final name = _queuePatientName(row, strings: s);
    final patient = _patientFromQueueRow(row);
    final phone = patientPhoneFrom(patient);
    final doctor = _queueDoctorName(row);
    final department = _queueDepartment(row);
    final status = _appointmentStatus(row);
    final dateTime = _queueAppointmentDateTimeLabel(row);
    final busy = id != null && _queueActionId == id;
    final selected = _queueRowMatchesSelectedPatient(row);
    final terminal = frontOfficeAppointmentStatusIsTerminal(status);
    final canConfirm = _canManageOpQueue && status == 'SCHEDULED';
    final canComplete =
        _canCompleteOpQueue &&
        (status == 'CONFIRMED' || status == 'IN_PROGRESS');
    final canNoShow = _canManageOpQueue;
    final canReschedule = _canManageOpQueue;
    final canCancel = _canManageOpQueue;
    final hasQueueAction =
        !terminal &&
        (canConfirm || canComplete || canNoShow || canReschedule || canCancel);
    final actions = <Widget>[
      if (canConfirm)
        _QueueActionButton(
          icon: Icons.check,
          label: s.lookup('s4.lib.front_office_workbench.check_in'),
          color: AppTheme.primaryTeal,
          onPressed: busy ? null : () => _confirmQueueAppointment(row),
        ),
      if (canComplete)
        _QueueActionButton(
          icon: Icons.done_all,
          label: s.lookup('s4.lib.front_office_workbench.complete'),
          color: AppTheme.successGreen,
          onPressed: busy ? null : () => _completeQueueAppointment(row),
        ),
      if (canNoShow)
        _QueueActionButton(
          icon: Icons.person_off_outlined,
          label: s.frontOfficeAppointmentStatusLabel('NO_SHOW'),
          color: AppTheme.textSecondary,
          onPressed: busy ? null : () => _markQueueNoShow(row),
        ),
      if (canReschedule)
        _QueueActionButton(
          icon: Icons.event_repeat_outlined,
          label: s.lookup('s4.lib.front_office_workbench.reschedule'),
          color: AppTheme.primaryBlue,
          onPressed: busy ? null : () => _rescheduleQueueAppointment(row),
        ),
      if (canCancel)
        _QueueActionButton(
          icon: Icons.cancel_outlined,
          label: s.actionCancel,
          color: AppTheme.errorRed,
          onPressed: busy ? null : () => _cancelQueueAppointment(row),
        ),
    ];
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: selected
            ? AppTheme.primaryBlue.withValues(alpha: 0.06)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => _selectQueuePatient(row),
          child: Padding(
            padding: const EdgeInsets.all(10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    CircleAvatar(
                      backgroundColor: _appointmentStatusColor(
                        status,
                      ).withValues(alpha: 0.12),
                      child: busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Icon(
                              selected
                                  ? Icons.person_pin_circle_outlined
                                  : Icons.person_outline,
                              color: _appointmentStatusColor(status),
                            ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontWeight: FontWeight.w800),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            [
                              if (dateTime.isNotEmpty) dateTime,
                              if (phone.isNotEmpty) phone,
                            ].join(' - '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            softWrap: false,
                            style: TextStyle(color: AppTheme.textSecondary),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    _StatusPill(
                      label: s.frontOfficeAppointmentStatusLabel(status),
                      color: _appointmentStatusColor(status),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: [
                    if (doctor.isNotEmpty)
                      _InfoPill(
                        icon: Icons.medical_services_outlined,
                        label: doctor,
                        color: AppTheme.primaryBlue,
                      ),
                    if (department.isNotEmpty)
                      _InfoPill(
                        icon: Icons.business_outlined,
                        label: department,
                        color: AppTheme.primaryTeal,
                      ),
                  ],
                ),
                if (hasQueueAction) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [for (final action in actions) action],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBillingPanel() {
    if (!_canBilling) return const SizedBox.shrink();
    final s = AppStrings.of(context);
    final selected = _selectedPatient;
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.receipt_long,
            title: s.lookup('s4.lib.front_office_workbench.billing'),
            trailing: selected == null
                ? null
                : Wrap(
                    spacing: 8,
                    children: [
                      TextButton.icon(
                        onPressed: () =>
                            context.push(_patientRoute('/billing-desk')),
                        icon: const Icon(Icons.open_in_new),
                        label: const AppText('s4.lib.patient_records.open'),
                      ),
                      FilledButton.icon(
                        onPressed: _billingActionBusy
                            ? null
                            : _createDraftInvoice,
                        icon: _billingActionBusy
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.add),
                        label: const AppText('s4.lib.billing_desk.draft_op'),
                      ),
                    ],
                  ),
          ),
          const SizedBox(height: 8),
          if (selected == null)
            _EmptyLine(
              icon: Icons.person_search,
              text: s.lookup('s4.lib.front_office_workbench.select_patient'),
            )
          else if (_invoiceBusy)
            const LinearProgressIndicator(minHeight: 2)
          else if (_patientInvoices.isEmpty)
            _EmptyLine(
              icon: Icons.receipt_long,
              text: s.lookup('s4.lib.front_office_workbench.no_invoices_found'),
            )
          else
            ..._patientInvoices.take(4).map(_invoiceTile),
        ],
      ),
    );
  }

  Widget _invoiceTile(Map<String, dynamic> invoice) {
    final id = invoice['invoice_number'] ?? '#${invoice['id']}';
    final status = invoice['status']?.toString().toUpperCase() ?? 'DRAFT';
    final invoiceType = invoice['invoice_type']?.toString() ?? 'OP';
    final isDraft = status == 'DRAFT';
    final due = billingInvoiceAmountDue(invoice);
    final canCollect = billingInvoiceCanCollect(invoice);
    final canPrintTax = billingInvoiceCanPrintTaxInvoice(invoice);
    final canPrintReceipt = billingInvoiceCanPrintReceipt(invoice);
    final actions = <Widget>[
      if (canPrintTax)
        IconButton.filledTonal(
          tooltip: AppStrings.of(
            context,
          ).lookup('s4.lib.billing_desk.print_tax_invoice'),
          onPressed: _billingActionBusy
              ? null
              : () => _printInvoiceDocument(
                  invoice,
                  BillingDocumentType.taxInvoice,
                ),
          icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
        ),
      if (canPrintReceipt)
        IconButton.filledTonal(
          tooltip: AppStrings.of(
            context,
          ).lookup('s4.lib.billing_desk.print_receipt'),
          onPressed: _billingActionBusy
              ? null
              : () =>
                    _printInvoiceDocument(invoice, BillingDocumentType.receipt),
          icon: const Icon(Icons.receipt_outlined, size: 18),
        ),
      if (isDraft)
        SizedBox(
          height: 34,
          child: OutlinedButton.icon(
            onPressed: _billingActionBusy ? null : () => _issueInvoice(invoice),
            icon: const Icon(Icons.publish_outlined, size: 16),
            label: const AppText('s4.lib.billing_desk.issue'),
          ),
        ),
      if (canCollect)
        BillingCollectButton(
          busy: _billingActionBusy,
          onPressed: () => _collectInvoicePayment(invoice),
        ),
    ];

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Theme.of(context).dividerColor),
          color: Theme.of(
            context,
          ).colorScheme.surfaceContainerHighest.withValues(alpha: 0.26),
        ),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final compact = constraints.maxWidth < 520;
            final details = Row(
              children: [
                const Icon(Icons.receipt_long_outlined, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        id.toString(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 2),
                      Wrap(
                        spacing: 8,
                        runSpacing: 4,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Text(
                            '$invoiceType - $status',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                          Text(
                            _money(due),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.bodyMedium
                                ?.copyWith(fontWeight: FontWeight.w700),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            );

            if (compact) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  details,
                  if (actions.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      alignment: WrapAlignment.end,
                      children: actions,
                    ),
                  ],
                ],
              );
            }

            return Row(
              children: [
                Expanded(child: details),
                if (actions.isNotEmpty) ...[
                  const SizedBox(width: 12),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 360),
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: actions,
                    ),
                  ),
                ],
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildAdmissionsPanel() {
    final s = AppStrings.of(context);
    return _Surface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _SectionTitle(
            icon: Icons.local_hospital,
            title: s.lookup(
              's4.lib.front_office_workbench.active_ip_admissions',
            ),
            trailing: Wrap(
              spacing: 8,
              children: [
                if (_canAdmitIp && _selectedPatient != null)
                  FilledButton.icon(
                    onPressed: _admissionActionBusy
                        ? null
                        : () => _showIpAdmissionDialog(),
                    icon: _admissionActionBusy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.add),
                    label: const AppText(
                      's4.lib.front_office_workbench.admit_ip',
                    ),
                  ),
                TextButton.icon(
                  onPressed: () => context.push('/emr/admissions'),
                  icon: const Icon(Icons.open_in_new),
                  label: const AppText('s4.lib.patient_records.open'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          if (_canViewAdmissionHandoffs) ...[
            Row(
              children: [
                const Icon(Icons.move_down_outlined, size: 18),
                const SizedBox(width: 6),
                Expanded(
                  child: AppText(
                    's4.lib.front_office_workbench.opd_ipd_handoff',
                    style: Theme.of(context).textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            if (_admissionHandoffs.isEmpty)
              _EmptyLine(
                icon: Icons.assignment_turned_in_outlined,
                text: s.lookup(
                  's4.lib.front_office_workbench.no_opd_admission_advice_pending',
                ),
              )
            else
              ..._admissionHandoffs.take(4).map(_admissionHandoffTile),
            const Divider(height: 22),
          ],
          if (_activeAdmissions.isEmpty)
            _EmptyLine(
              icon: Icons.local_hospital_outlined,
              text: s.lookup(
                's4.lib.front_office_workbench.no_active_admissions',
              ),
            )
          else ...[
            ..._activeAdmissions.take(5).map(_admissionTile),
            if (_activeAdmissionsTotal > _activeAdmissions.take(5).length) ...[
              const SizedBox(height: 6),
              Text(
                s.format(
                  's4.dynamic.front_office_workbench.active_admissions_limited',
                  {
                    'shown': _activeAdmissions.take(5).length,
                    'total': _activeAdmissionsTotal,
                  },
                ),
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: AppTheme.textSecondary),
              ),
            ],
          ],
        ],
      ),
    );
  }

  Widget _admissionHandoffTile(Map<String, dynamic> row) {
    final s = AppStrings.of(context);
    final patient = frontOfficeAdmissionAdvicePatientFrom(row);
    final name = _text(patient?['name']);
    final phone = _text(patient?['phone']);
    final doctor = _firstText([
      row['doctor_name'],
      row['doctorName'],
      row['consultant_name'],
      row['consultantName'],
    ]);
    final advisedAt = _admissionAdviceDate(row);
    final note = _admissionAdviceNote(row);
    final busy = _admissionActionBusy;

    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: AppTheme.warningAmber.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: AppTheme.warningAmber.withValues(alpha: 0.24),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.assignment_returned_outlined),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    name.isEmpty
                        ? s.lookup(
                            's4.lib.front_office_workbench.patient_advised_for_ip',
                          )
                        : name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
                if (busy)
                  const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              [
                if (phone.isNotEmpty) phone,
                if (doctor.isNotEmpty) doctor,
                if (advisedAt.isNotEmpty) advisedAt,
                if (note.isNotEmpty) note,
              ].join(' - '),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: AppTheme.textSecondary),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                _InfoPill(
                  icon: Icons.rule_outlined,
                  label: s.lookup(
                    's4.lib.front_office_workbench.needs_bed_deposit_consent',
                  ),
                  color: AppTheme.warningAmber,
                ),
                OutlinedButton.icon(
                  onPressed: () => _showAdmissionAdviceDialog(row),
                  icon: const Icon(Icons.visibility_outlined, size: 16),
                  label: const AppText(
                    's4.lib.front_office_workbench.view_advice',
                  ),
                ),
                FilledButton.icon(
                  onPressed: busy ? null : () => _startAdmissionFromAdvice(row),
                  icon: const Icon(Icons.bed_outlined, size: 16),
                  label: const AppText(
                    's4.lib.front_office_workbench.assign_ward_bed',
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: patient == null
                      ? null
                      : () => _openBillingForAdvice(row),
                  icon: const Icon(Icons.account_balance_wallet_outlined),
                  label: const AppText(
                    's4.lib.front_office_workbench.billing_deposit',
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _admissionTile(Map<String, dynamic> row) {
    final s = AppStrings.of(context);
    final name =
        row['patient_name'] ??
        row['name'] ??
        s.lookup('s4.lib.front_office_workbench.patient');
    final ward = row['ward'] ?? row['ward_name'] ?? row['bed_ward_name'];
    final admittedAt = row['admitted_at'] ?? row['created_at'];
    final date = admittedAt == null
        ? null
        : DateTime.tryParse(admittedAt.toString())?.toLocal();
    return ListTile(
      dense: true,
      contentPadding: EdgeInsets.zero,
      leading: const Icon(Icons.bed_outlined),
      title: Text(
        name.toString(),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: Text(
        [
          ?ward,
          if (date != null) DateFormat('dd MMM, HH:mm').format(date),
        ].join(' - '),
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: () => context.push('/emr/admissions'),
    );
  }
}
