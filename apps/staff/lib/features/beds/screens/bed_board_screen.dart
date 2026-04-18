import 'dart:async';

import 'package:flutter/material.dart';
import 'package:vhhealth_core/services/realtime_client.dart';
import '../../../core/services/api_client.dart';
import '../../../core/theme/app_theme.dart';

class BedBoardScreen extends StatefulWidget {
  const BedBoardScreen({super.key});

  @override
  State<BedBoardScreen> createState() => _BedBoardScreenState();
}

class _BedBoardScreenState extends State<BedBoardScreen> {
  List<Map<String, dynamic>> _wards = [];
  List<Map<String, dynamic>> _beds = [];
  String? _selectedWardId;
  String? _selectedWardName;
  String _searchQuery = '';
  bool _loadingWards = true;
  bool _loadingBeds = false;
  String? _error;

  StreamSubscription<RealtimeEvent>? _bedEventSub;
  Timer? _refreshDebounce;

  @override
  void initState() {
    super.initState();
    _fetchWards();
    _attachRealtime();
  }

  Future<void> _attachRealtime() async {
    final rt = RealtimeClient.instance;
    await rt.connect();
    _bedEventSub = rt.events('staff:beds').listen((_) => _debouncedRefresh());
  }

  void _debouncedRefresh() {
    _refreshDebounce?.cancel();
    _refreshDebounce = Timer(const Duration(milliseconds: 400), () {
      if (!mounted) return;
      if (_selectedWardId != null) {
        _fetchBeds(_selectedWardId!);
      }
    });
  }

  @override
  void dispose() {
    _bedEventSub?.cancel();
    _refreshDebounce?.cancel();
    super.dispose();
  }

  Future<void> _fetchWards() async {
    setState(() {
      _loadingWards = true;
      _error = null;
    });
    try {
      final response = await ApiClient.get('/wards');
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['wards'] ?? [] : []);
        _wards = List<Map<String, dynamic>>.from(
          (list as List).map((w) => w is Map<String, dynamic> ? w : <String, dynamic>{}),
        );
      } else {
        _error = response.message ?? 'Failed to load wards';
      }
    } catch (e) {
      _error = 'Could not connect to server';
    } finally {
      if (mounted) setState(() => _loadingWards = false);
    }
  }

  Future<void> _fetchBeds(String wardId) async {
    setState(() {
      _loadingBeds = true;
      _beds = [];
    });
    try {
      final response = await ApiClient.get('/beds/ward/$wardId');
      if (response.isSuccess) {
        final data = response.data;
        final list = data is List
            ? data
            : (data is Map ? data['beds'] ?? [] : []);
        _beds = List<Map<String, dynamic>>.from(
          (list as List).map((b) => b is Map<String, dynamic> ? b : <String, dynamic>{}),
        );
      }
    } catch (e) {
      debugPrint('bed_board_screen.dart: $e');
    } finally {
      if (mounted) setState(() => _loadingBeds = false);
    }
  }

  Color _statusColor(String? status) {
    switch (status?.toLowerCase()) {
      case 'available':
        return AppTheme.successGreen;
      case 'occupied':
        return AppTheme.errorRed;
      case 'maintenance':
        return const Color(0xFFF9A825);
      default:
        return Colors.grey;
    }
  }

  IconData _statusIcon(String? status) {
    switch (status?.toLowerCase()) {
      case 'available':
        return Icons.check_circle_outline;
      case 'occupied':
        return Icons.person;
      case 'maintenance':
        return Icons.build_circle_outlined;
      default:
        return Icons.bed;
    }
  }

  List<Map<String, dynamic>> get _filteredWards {
    if (_searchQuery.isEmpty) return _wards;
    final q = _searchQuery.toLowerCase();
    return _wards.where((w) {
      final name = (w['name'] ?? w['wardName'] ?? '').toString().toLowerCase();
      return name.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppTheme.backgroundGrey,
      appBar: AppBar(
        title: const Text('Bed Board'),
        backgroundColor: AppTheme.primaryBlue,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () {
              _fetchWards();
              if (_selectedWardId != null) _fetchBeds(_selectedWardId!);
            },
          ),
        ],
      ),
      body: _loadingWards
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? _buildError()
              : _selectedWardId == null
                  ? _buildWardList()
                  : _buildBedGrid(),
    );
  }

  Widget _buildError() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.error_outline, size: 48, color: AppTheme.errorRed),
          const SizedBox(height: 16),
          Text(_error!, style: const TextStyle(color: AppTheme.textSecondary)),
          const SizedBox(height: 16),
          ElevatedButton.icon(
            onPressed: _fetchWards,
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ],
      ),
    );
  }

  Widget _buildWardList() {
    return Column(
      children: [
        // Search bar
        Padding(
          padding: const EdgeInsets.all(16),
          child: TextField(
            decoration: InputDecoration(
              hintText: 'Search wards...',
              prefixIcon: const Icon(Icons.search),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              filled: true,
              fillColor: Colors.white,
            ),
            onChanged: (v) => setState(() => _searchQuery = v),
          ),
        ),

        // Legend
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              _legendDot(AppTheme.successGreen, 'Available'),
              const SizedBox(width: 16),
              _legendDot(AppTheme.errorRed, 'Occupied'),
              const SizedBox(width: 16),
              _legendDot(const Color(0xFFF9A825), 'Maintenance'),
            ],
          ),
        ),
        const SizedBox(height: 8),

        // Ward list
        Expanded(
          child: _filteredWards.isEmpty
              ? const Center(
                  child: Text('No wards found',
                      style: TextStyle(color: AppTheme.textSecondary)),
                )
              : RefreshIndicator(
                  onRefresh: _fetchWards,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(16),
                    itemCount: _filteredWards.length,
                    itemBuilder: (context, index) {
                      final ward = _filteredWards[index];
                      final name = ward['name'] ?? ward['wardName'] ?? 'Ward ${index + 1}';
                      final totalBeds = ward['totalBeds'] ?? ward['total'] ?? 0;
                      final available = ward['availableBeds'] ?? ward['available'] ?? 0;
                      final occupied = ward['occupiedBeds'] ?? ward['occupied'] ?? 0;
                      final wardId = (ward['id'] ?? ward['_id'] ?? ward['wardId'] ?? '').toString();

                      return Card(
                        margin: const EdgeInsets.only(bottom: 12),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: ListTile(
                          contentPadding: const EdgeInsets.all(16),
                          leading: Container(
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                              color: AppTheme.primaryBlue.withValues(alpha: 0.1),
                              borderRadius: BorderRadius.circular(10),
                            ),
                            child: const Icon(Icons.local_hotel, color: AppTheme.primaryBlue),
                          ),
                          title: Text(
                            name.toString(),
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                          subtitle: Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Row(
                              children: [
                                _miniStat('Total', '$totalBeds', Colors.grey),
                                const SizedBox(width: 12),
                                _miniStat('Free', '$available', AppTheme.successGreen),
                                const SizedBox(width: 12),
                                _miniStat('Used', '$occupied', AppTheme.errorRed),
                              ],
                            ),
                          ),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () {
                            setState(() {
                              _selectedWardId = wardId;
                              _selectedWardName = name.toString();
                            });
                            _fetchBeds(wardId);
                          },
                        ),
                      );
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget _buildBedGrid() {
    return Column(
      children: [
        // Header with back
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          color: Colors.white,
          child: Row(
            children: [
              IconButton(
                icon: const Icon(Icons.arrow_back),
                onPressed: () => setState(() {
                  _selectedWardId = null;
                  _selectedWardName = null;
                  _beds = [];
                }),
              ),
              Text(
                _selectedWardName ?? 'Ward',
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                  color: AppTheme.textPrimary,
                ),
              ),
              const Spacer(),
              Text(
                '${_beds.where((b) => (b['status'] ?? '').toString().toLowerCase() == 'available').length} available',
                style: const TextStyle(
                  color: AppTheme.successGreen,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 12),
            ],
          ),
        ),

        // Bed grid
        Expanded(
          child: _loadingBeds
              ? const Center(child: CircularProgressIndicator())
              : _beds.isEmpty
                  ? const Center(
                      child: Text('No beds found in this ward',
                          style: TextStyle(color: AppTheme.textSecondary)),
                    )
                  : RefreshIndicator(
                      onRefresh: () => _fetchBeds(_selectedWardId!),
                      child: GridView.builder(
                        padding: const EdgeInsets.all(16),
                        gridDelegate:
                            const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          mainAxisSpacing: 12,
                          crossAxisSpacing: 12,
                          childAspectRatio: 1.3,
                        ),
                        itemCount: _beds.length,
                        itemBuilder: (context, index) {
                          final bed = _beds[index];
                          return _buildBedCard(bed);
                        },
                      ),
                    ),
        ),
      ],
    );
  }

  Widget _buildBedCard(Map<String, dynamic> bed) {
    final status = (bed['status'] ?? 'available').toString();
    final bedNumber = bed['bedNumber'] ?? bed['number'] ?? bed['name'] ?? '';
    final patientName = bed['patientName'] ?? bed['patient']?['name'] ?? '';
    final doctorName = bed['doctorName'] ?? bed['doctor']?['name'] ?? '';
    final color = _statusColor(status);

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color, width: 2),
        boxShadow: [
          BoxShadow(
            color: color.withValues(alpha: 0.15),
            blurRadius: 8,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(_statusIcon(status), color: color, size: 20),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  'Bed $bedNumber',
                  style: TextStyle(
                    fontWeight: FontWeight.bold,
                    color: color,
                    fontSize: 14,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              status.isNotEmpty ? status[0].toUpperCase() + status.substring(1).toLowerCase() : status,
              style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600),
            ),
          ),
          if (status.toLowerCase() == 'occupied' && patientName.toString().isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              patientName.toString(),
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (doctorName.toString().isNotEmpty)
              Text(
                'Dr. $doctorName',
                style: const TextStyle(fontSize: 11, color: AppTheme.textSecondary),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
          ],
        ],
      ),
    );
  }

  Widget _legendDot(Color color, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 4),
        Text(label, style: const TextStyle(fontSize: 12, color: AppTheme.textSecondary)),
      ],
    );
  }

  Widget _miniStat(String label, String value, Color color) {
    return Column(
      children: [
        Text(value, style: TextStyle(fontWeight: FontWeight.bold, color: color, fontSize: 14)),
        Text(label, style: const TextStyle(fontSize: 10, color: AppTheme.textSecondary)),
      ],
    );
  }
}
