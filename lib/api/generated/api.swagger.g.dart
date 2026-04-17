// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'api.swagger.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Error _$ErrorFromJson(Map<String, dynamic> json) => Error(
  success: json['success'] as bool? ?? false,
  message: json['message'] as String?,
  error: json['error'] as String?,
  details: json['details'],
);

Map<String, dynamic> _$ErrorToJson(Error instance) => <String, dynamic>{
  'success': instance.success,
  'message': instance.message,
  'error': instance.error,
  'details': instance.details,
};

Success _$SuccessFromJson(Map<String, dynamic> json) => Success(
  success: json['success'] as bool? ?? false,
  message: json['message'] as String?,
  data: json['data'],
);

Map<String, dynamic> _$SuccessToJson(Success instance) => <String, dynamic>{
  'success': instance.success,
  'message': instance.message,
  'data': instance.data,
};

PaginatedResponse _$PaginatedResponseFromJson(Map<String, dynamic> json) =>
    PaginatedResponse(
      success: json['success'] as bool? ?? false,
      message: json['message'] as String?,
      data: json['data'] == null
          ? null
          : PaginatedResponse$Data.fromJson(
              json['data'] as Map<String, dynamic>,
            ),
    );

Map<String, dynamic> _$PaginatedResponseToJson(PaginatedResponse instance) =>
    <String, dynamic>{
      'success': instance.success,
      'message': instance.message,
      'data': instance.data?.toJson(),
    };

ValidationError$Response _$ValidationError$ResponseFromJson(
  Map<String, dynamic> json,
) => ValidationError$Response(
  errors: (json['errors'] as List<dynamic>?)
      ?.map(
        (e) => ValidationError$Response$Errors$Item.fromJson(
          e as Map<String, dynamic>,
        ),
      )
      .toList(),
  success: json['success'] as bool? ?? false,
  message: json['message'] as String?,
  error: json['error'] as String?,
  details: json['details'],
);

Map<String, dynamic> _$ValidationError$ResponseToJson(
  ValidationError$Response instance,
) => <String, dynamic>{
  'errors': instance.errors?.map((e) => e.toJson()).toList(),
  'success': instance.success,
  'message': instance.message,
  'error': instance.error,
  'details': instance.details,
};

PaginatedResponse$Data _$PaginatedResponse$DataFromJson(
  Map<String, dynamic> json,
) => PaginatedResponse$Data(
  items:
      (json['items'] as List<dynamic>?)?.map((e) => e as Object).toList() ?? [],
  pagination: json['pagination'] == null
      ? null
      : PaginatedResponse$Data$Pagination.fromJson(
          json['pagination'] as Map<String, dynamic>,
        ),
);

Map<String, dynamic> _$PaginatedResponse$DataToJson(
  PaginatedResponse$Data instance,
) => <String, dynamic>{
  'items': instance.items,
  'pagination': instance.pagination?.toJson(),
};

ValidationError$Response$Errors$Item
_$ValidationError$Response$Errors$ItemFromJson(Map<String, dynamic> json) =>
    ValidationError$Response$Errors$Item(
      field: json['field'] as String?,
      message: json['message'] as String?,
    );

Map<String, dynamic> _$ValidationError$Response$Errors$ItemToJson(
  ValidationError$Response$Errors$Item instance,
) => <String, dynamic>{'field': instance.field, 'message': instance.message};

PaginatedResponse$Data$Pagination _$PaginatedResponse$Data$PaginationFromJson(
  Map<String, dynamic> json,
) => PaginatedResponse$Data$Pagination(
  page: (json['page'] as num?)?.toInt(),
  limit: (json['limit'] as num?)?.toInt(),
  total: (json['total'] as num?)?.toInt(),
  totalPages: (json['totalPages'] as num?)?.toInt(),
);

Map<String, dynamic> _$PaginatedResponse$Data$PaginationToJson(
  PaginatedResponse$Data$Pagination instance,
) => <String, dynamic>{
  'page': instance.page,
  'limit': instance.limit,
  'total': instance.total,
  'totalPages': instance.totalPages,
};
