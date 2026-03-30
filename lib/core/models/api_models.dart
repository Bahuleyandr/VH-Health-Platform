/// Auto-generated API model classes for VH Health.
/// Mirrors the backend Prisma schema (vh-health-backend/prisma/schema.prisma).
///
/// Generated on: 2026-03-28
/// Do NOT edit manually — re-generate from the Prisma schema when models change.
library;

// ===================================================================
// USER
// ===================================================================

class User {
  final int id;
  final String uid;
  final String phone;
  final String? name;
  final String? gender;
  final String? address;
  final String? email;
  final String? birthday;
  final String? anniversary;
  final String? profilePicture;
  final String? role;
  final bool isActive;
  final String registeredAt;
  final String updatedAt;

  const User({
    required this.id,
    required this.uid,
    required this.phone,
    this.name,
    this.gender,
    this.address,
    this.email,
    this.birthday,
    this.anniversary,
    this.profilePicture,
    this.role,
    this.isActive = true,
    required this.registeredAt,
    required this.updatedAt,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'] as int,
      uid: json['uid'] as String,
      phone: json['phone'] as String,
      name: json['name'] as String?,
      gender: json['gender'] as String?,
      address: json['address'] as String?,
      email: json['email'] as String?,
      birthday: json['birthday'] as String?,
      anniversary: json['anniversary'] as String?,
      profilePicture: json['profile_picture'] as String?,
      role: json['role'] as String?,
      isActive: json['is_active'] as bool? ?? true,
      registeredAt: json['registered_at'] as String,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'uid': uid,
      'phone': phone,
      'name': name,
      'gender': gender,
      'address': address,
      'email': email,
      'birthday': birthday,
      'anniversary': anniversary,
      'profile_picture': profilePicture,
      'role': role,
      'is_active': isActive,
      'registered_at': registeredAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// APPOINTMENT
// ===================================================================

class Appointment {
  final int id;
  final String? uid;
  final String phone;
  final int? doctorId;
  final String doctorName;
  final String? patientName;
  final String appointmentDate;
  final String appointmentTime;
  final String status;
  final String? reason;
  final String? notes;
  final String createdAt;
  final String updatedAt;

  const Appointment({
    required this.id,
    this.uid,
    required this.phone,
    this.doctorId,
    required this.doctorName,
    this.patientName,
    required this.appointmentDate,
    required this.appointmentTime,
    required this.status,
    this.reason,
    this.notes,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Appointment.fromJson(Map<String, dynamic> json) {
    return Appointment(
      id: json['id'] as int,
      uid: json['uid'] as String?,
      phone: json['phone'] as String,
      doctorId: json['doctor_id'] as int?,
      doctorName: json['doctor_name'] as String,
      patientName: json['patient_name'] as String?,
      appointmentDate: json['appointment_date'] as String,
      appointmentTime: json['appointment_time'] as String,
      status: json['status'] as String,
      reason: json['reason'] as String?,
      notes: json['notes'] as String?,
      createdAt: json['created_at'] as String,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'uid': uid,
      'phone': phone,
      'doctor_id': doctorId,
      'doctor_name': doctorName,
      'patient_name': patientName,
      'appointment_date': appointmentDate,
      'appointment_time': appointmentTime,
      'status': status,
      'reason': reason,
      'notes': notes,
      'created_at': createdAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// PHARMACY ORDER
// ===================================================================

class PharmacyOrder {
  final int id;
  final String? uid;
  final String phone;
  final String orderNote;
  final String? medication;
  final String status;
  final String? priority;
  final String? fileKey;
  final String? prescribedBy;
  final String? dispensedBy;
  final String orderedAt;
  final String? dispensedAt;
  final String updatedAt;

  const PharmacyOrder({
    required this.id,
    this.uid,
    required this.phone,
    required this.orderNote,
    this.medication,
    required this.status,
    this.priority,
    this.fileKey,
    this.prescribedBy,
    this.dispensedBy,
    required this.orderedAt,
    this.dispensedAt,
    required this.updatedAt,
  });

  factory PharmacyOrder.fromJson(Map<String, dynamic> json) {
    return PharmacyOrder(
      id: json['id'] as int,
      uid: json['uid'] as String?,
      phone: json['phone'] as String,
      orderNote: json['order_note'] as String,
      medication: json['medication'] as String?,
      status: json['status'] as String,
      priority: json['priority'] as String?,
      fileKey: json['file_key'] as String?,
      prescribedBy: json['prescribed_by'] as String?,
      dispensedBy: json['dispensed_by'] as String?,
      orderedAt: json['ordered_at'] as String,
      dispensedAt: json['dispensed_at'] as String?,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'uid': uid,
      'phone': phone,
      'order_note': orderNote,
      'medication': medication,
      'status': status,
      'priority': priority,
      'file_key': fileKey,
      'prescribed_by': prescribedBy,
      'dispensed_by': dispensedBy,
      'ordered_at': orderedAt,
      'dispensed_at': dispensedAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// INVESTIGATION
// ===================================================================

class Investigation {
  final int id;
  final String? uid;
  final String phone;
  final String testName;
  final String? testType;
  final String status;
  final String? resultFile;
  final String? fileKey;
  final String? priority;
  final String? requestedBy;
  final String requestedAt;
  final String? completedAt;
  final String updatedAt;

  const Investigation({
    required this.id,
    this.uid,
    required this.phone,
    required this.testName,
    this.testType,
    required this.status,
    this.resultFile,
    this.fileKey,
    this.priority,
    this.requestedBy,
    required this.requestedAt,
    this.completedAt,
    required this.updatedAt,
  });

  factory Investigation.fromJson(Map<String, dynamic> json) {
    return Investigation(
      id: json['id'] as int,
      uid: json['uid'] as String?,
      phone: json['phone'] as String,
      testName: json['test_name'] as String,
      testType: json['test_type'] as String?,
      status: json['status'] as String,
      resultFile: json['result_file'] as String?,
      fileKey: json['file_key'] as String?,
      priority: json['priority'] as String?,
      requestedBy: json['requested_by'] as String?,
      requestedAt: json['requested_at'] as String,
      completedAt: json['completed_at'] as String?,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'uid': uid,
      'phone': phone,
      'test_name': testName,
      'test_type': testType,
      'status': status,
      'result_file': resultFile,
      'file_key': fileKey,
      'priority': priority,
      'requested_by': requestedBy,
      'requested_at': requestedAt,
      'completed_at': completedAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// DOCTOR
// ===================================================================

class Doctor {
  final int id;
  final int? userId;
  final String name;
  final int? departmentId;
  final String department;
  final String? specialty;
  final String? intro;
  final String? imageUrl;
  final bool isAvailable;
  final bool isActive;
  final String createdAt;
  final String updatedAt;

  const Doctor({
    required this.id,
    this.userId,
    required this.name,
    this.departmentId,
    required this.department,
    this.specialty,
    this.intro,
    this.imageUrl,
    this.isAvailable = true,
    this.isActive = true,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Doctor.fromJson(Map<String, dynamic> json) {
    return Doctor(
      id: json['id'] as int,
      userId: json['user_id'] as int?,
      name: json['name'] as String,
      departmentId: json['department_id'] as int?,
      department: json['department'] as String,
      specialty: json['specialty'] as String?,
      intro: json['intro'] as String?,
      imageUrl: json['image_url'] as String?,
      isAvailable: json['is_available'] as bool? ?? true,
      isActive: json['is_active'] as bool? ?? true,
      createdAt: json['created_at'] as String,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'user_id': userId,
      'name': name,
      'department_id': departmentId,
      'department': department,
      'specialty': specialty,
      'intro': intro,
      'image_url': imageUrl,
      'is_available': isAvailable,
      'is_active': isActive,
      'created_at': createdAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// DEPARTMENT
// ===================================================================

class Department {
  final int id;
  final String name;
  final String? description;
  final bool isActive;
  final String createdAt;
  final String updatedAt;

  const Department({
    required this.id,
    required this.name,
    this.description,
    this.isActive = true,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Department.fromJson(Map<String, dynamic> json) {
    return Department(
      id: json['id'] as int,
      name: json['name'] as String,
      description: json['description'] as String?,
      isActive: json['is_active'] as bool? ?? true,
      createdAt: json['created_at'] as String,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'description': description,
      'is_active': isActive,
      'created_at': createdAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// NOTIFICATION
// ===================================================================

class Notification {
  final int id;
  final String? uid;
  final String phone;
  final String title;
  final String body;
  final String type;
  final String priority;
  final Map<String, dynamic>? data;
  final bool isRead;
  final String? scheduledFor;
  final String? sentAt;
  final String? readAt;
  final String createdAt;
  final String updatedAt;

  const Notification({
    required this.id,
    this.uid,
    required this.phone,
    required this.title,
    required this.body,
    required this.type,
    required this.priority,
    this.data,
    this.isRead = false,
    this.scheduledFor,
    this.sentAt,
    this.readAt,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Notification.fromJson(Map<String, dynamic> json) {
    return Notification(
      id: json['id'] as int,
      uid: json['uid'] as String?,
      phone: json['phone'] as String,
      title: json['title'] as String,
      body: json['body'] as String,
      type: json['type'] as String,
      priority: json['priority'] as String,
      data: json['data'] as Map<String, dynamic>?,
      isRead: json['is_read'] as bool? ?? false,
      scheduledFor: json['scheduled_for'] as String?,
      sentAt: json['sent_at'] as String?,
      readAt: json['read_at'] as String?,
      createdAt: json['created_at'] as String,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'uid': uid,
      'phone': phone,
      'title': title,
      'body': body,
      'type': type,
      'priority': priority,
      'data': data,
      'is_read': isRead,
      'scheduled_for': scheduledFor,
      'sent_at': sentAt,
      'read_at': readAt,
      'created_at': createdAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// HEALTH RECORD
// ===================================================================

class HealthRecord {
  final int id;
  final String? uid;
  final String phone;
  final String? recordType;
  final String fileName;
  final String fileType;
  final String? fileKey;
  final int? fileSize;
  final String privacyLevel;
  final String? createdBy;
  final String createdAt;
  final String updatedAt;

  const HealthRecord({
    required this.id,
    this.uid,
    required this.phone,
    this.recordType,
    required this.fileName,
    required this.fileType,
    this.fileKey,
    this.fileSize,
    this.privacyLevel = 'RESTRICTED',
    this.createdBy,
    required this.createdAt,
    required this.updatedAt,
  });

  factory HealthRecord.fromJson(Map<String, dynamic> json) {
    return HealthRecord(
      id: json['id'] as int,
      uid: json['uid'] as String?,
      phone: json['phone'] as String,
      recordType: json['record_type'] as String?,
      fileName: json['file_name'] as String,
      fileType: json['file_type'] as String,
      fileKey: json['file_key'] as String?,
      fileSize: json['file_size'] as int?,
      privacyLevel: json['privacy_level'] as String? ?? 'RESTRICTED',
      createdBy: json['created_by'] as String?,
      createdAt: json['created_at'] as String,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'uid': uid,
      'phone': phone,
      'record_type': recordType,
      'file_name': fileName,
      'file_type': fileType,
      'file_key': fileKey,
      'file_size': fileSize,
      'privacy_level': privacyLevel,
      'created_by': createdBy,
      'created_at': createdAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// MEDICATION
// ===================================================================

class Medication {
  final int id;
  final String name;
  final String? genericName;
  final String? brand;
  final String? category;
  final String? dosage;
  final String? form;
  final double? price;
  final int? stockQuantity;
  final String? expiryDate;
  final String? manufacturer;
  final bool prescriptionRequired;
  final String? description;
  final bool isActive;
  final String createdAt;
  final String? createdBy;

  const Medication({
    required this.id,
    required this.name,
    this.genericName,
    this.brand,
    this.category,
    this.dosage,
    this.form,
    this.price,
    this.stockQuantity,
    this.expiryDate,
    this.manufacturer,
    this.prescriptionRequired = false,
    this.description,
    this.isActive = true,
    required this.createdAt,
    this.createdBy,
  });

  factory Medication.fromJson(Map<String, dynamic> json) {
    return Medication(
      id: json['id'] as int,
      name: json['name'] as String,
      genericName: json['generic_name'] as String?,
      brand: json['brand'] as String?,
      category: json['category'] as String?,
      dosage: json['dosage'] as String?,
      form: json['form'] as String?,
      price: (json['price'] as num?)?.toDouble(),
      stockQuantity: json['stock_quantity'] as int?,
      expiryDate: json['expiry_date'] as String?,
      manufacturer: json['manufacturer'] as String?,
      prescriptionRequired: json['prescription_required'] as bool? ?? false,
      description: json['description'] as String?,
      isActive: json['is_active'] as bool? ?? true,
      createdAt: json['created_at'] as String,
      createdBy: json['created_by'] as String?,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'generic_name': genericName,
      'brand': brand,
      'category': category,
      'dosage': dosage,
      'form': form,
      'price': price,
      'stock_quantity': stockQuantity,
      'expiry_date': expiryDate,
      'manufacturer': manufacturer,
      'prescription_required': prescriptionRequired,
      'description': description,
      'is_active': isActive,
      'created_at': createdAt,
      'created_by': createdBy,
    };
  }
}

// ===================================================================
// FEEDBACK
// ===================================================================

class Feedback {
  final int id;
  final String? uid;
  final String phone;
  final int rating;
  final String? comment;
  final String? category;
  final int? departmentId;
  final int? doctorId;
  final int? appointmentId;
  final bool isAnonymous;
  final String status;
  final String createdAt;
  final String updatedAt;

  const Feedback({
    required this.id,
    this.uid,
    required this.phone,
    required this.rating,
    this.comment,
    this.category,
    this.departmentId,
    this.doctorId,
    this.appointmentId,
    this.isAnonymous = false,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
  });

  factory Feedback.fromJson(Map<String, dynamic> json) {
    return Feedback(
      id: json['id'] as int,
      uid: json['uid'] as String?,
      phone: json['phone'] as String,
      rating: json['rating'] as int,
      comment: json['comment'] as String?,
      category: json['category'] as String?,
      departmentId: json['department_id'] as int?,
      doctorId: json['doctor_id'] as int?,
      appointmentId: json['appointment_id'] as int?,
      isAnonymous: json['is_anonymous'] as bool? ?? false,
      status: json['status'] as String,
      createdAt: json['created_at'] as String,
      updatedAt: json['updated_at'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'uid': uid,
      'phone': phone,
      'rating': rating,
      'comment': comment,
      'category': category,
      'department_id': departmentId,
      'doctor_id': doctorId,
      'appointment_id': appointmentId,
      'is_anonymous': isAnonymous,
      'status': status,
      'created_at': createdAt,
      'updated_at': updatedAt,
    };
  }
}

// ===================================================================
// API ENVELOPE HELPERS
// ===================================================================

class ApiEnvelope<T> {
  final bool success;
  final String? message;
  final T? data;
  final String? requestId;

  const ApiEnvelope({
    required this.success,
    this.message,
    this.data,
    this.requestId,
  });

  factory ApiEnvelope.fromJson(
    Map<String, dynamic> json,
    T Function(dynamic) fromJsonT,
  ) {
    return ApiEnvelope(
      success: json['success'] as bool,
      message: json['message'] as String?,
      data: json['data'] != null ? fromJsonT(json['data']) : null,
      requestId: json['requestId'] as String?,
    );
  }
}

class PaginationMeta {
  final int page;
  final int limit;
  final int total;
  final int totalPages;

  const PaginationMeta({
    required this.page,
    required this.limit,
    required this.total,
    required this.totalPages,
  });

  factory PaginationMeta.fromJson(Map<String, dynamic> json) {
    return PaginationMeta(
      page: json['page'] as int,
      limit: json['limit'] as int,
      total: json['total'] as int,
      totalPages: json['totalPages'] as int,
    );
  }
}

class PaginatedData<T> {
  final List<T> items;
  final PaginationMeta pagination;

  const PaginatedData({
    required this.items,
    required this.pagination,
  });

  factory PaginatedData.fromJson(
    Map<String, dynamic> json,
    T Function(Map<String, dynamic>) fromJsonT,
  ) {
    return PaginatedData(
      items: (json['items'] as List<dynamic>)
          .map((e) => fromJsonT(e as Map<String, dynamic>))
          .toList(),
      pagination:
          PaginationMeta.fromJson(json['pagination'] as Map<String, dynamic>),
    );
  }
}
