// GENERATED CODE - DO NOT MODIFY BY HAND
// dart format width=80

part of 'api.swagger.dart';

// **************************************************************************
// ChopperGenerator
// **************************************************************************

// coverage:ignore-file
// ignore_for_file: type=lint
final class _$Api extends Api {
  _$Api([ChopperClient? client]) {
    if (client == null) return;
    this.client = client;
  }

  @override
  final Type definitionType = Api;

  @override
  Future<Response<PaginatedResponse>> _apiDocsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for swagger service. Security: public',
      summary: 'Api Docs',
      operationId: 'getApidocs',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiDocsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for swagger service. Security: public',
      summary: 'POST Api Docs',
      operationId: 'postApidocs',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiDocsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for swagger service. Security: public',
      summary: 'Get swagger by ID',
      operationId: 'getApidocs_2',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiDocsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for swagger service. Security: public',
      summary: 'Update swagger by ID',
      operationId: 'putApidocs',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiDocsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'DELETE endpoint for swagger service. Security: public',
      summary: 'Delete swagger by ID',
      operationId: 'deleteApidocs',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiDocsEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for swagger service. Security: public',
      summary: 'Endpoint5',
      operationId: 'getApidocsEndpoint5',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiDocsEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for swagger service. Security: public',
      summary: 'Endpoint6',
      operationId: 'getApidocsEndpoint6',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiDocsEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for swagger service. Security: public',
      summary: 'Endpoint7',
      operationId: 'getApidocsEndpoint7',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiDocsEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for swagger service. Security: public',
      summary: 'Endpoint8',
      operationId: 'getApidocsEndpoint8',
      consumes: [],
      produces: [],
      security: [],
      tags: ["swagger"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api-docs/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'List admin',
      operationId: 'getAdmin',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for admin service. Security: admin only',
      summary: 'Create admin',
      operationId: 'postAdmin',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Get admin by ID',
      operationId: 'getAdmin_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for admin service. Security: admin only',
      summary: 'Update admin by ID',
      operationId: 'putAdmin',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1AdminIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'DELETE endpoint for admin service. Security: admin only',
      summary: 'Delete admin by ID',
      operationId: 'deleteAdmin',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminDepartmentsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminDepartments service. Security: admin only',
      summary: 'Departments',
      operationId: 'getAdminDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDepartments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/departments');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminDepartmentsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for adminDepartments service. Security: admin only',
      summary: 'POST Departments',
      operationId: 'postAdminDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDepartments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/departments');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminDepartmentsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminDepartments service. Security: admin only',
      summary: 'Get adminDepartments by ID',
      operationId: 'getAdminDepartments_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDepartments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/departments/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminDepartmentsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for adminDepartments service. Security: admin only',
      summary: 'Update adminDepartments by ID',
      operationId: 'putAdminDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDepartments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/departments/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1AdminDepartmentsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for adminDepartments service. Security: admin only',
      summary: 'Delete adminDepartments by ID',
      operationId: 'deleteAdminDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDepartments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/departments/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminDepartmentsEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminDepartments service. Security: admin only',
      summary: 'Endpoint5',
      operationId: 'getAdminDepartmentsEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDepartments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/departments/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminDepartmentsEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminDepartments service. Security: admin only',
      summary: 'Endpoint6',
      operationId: 'getAdminDepartmentsEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDepartments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/departments/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminDepartmentsEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminDepartments service. Security: admin only',
      summary: 'Endpoint7',
      operationId: 'getAdminDepartmentsEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDepartments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/departments/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminDoctorsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminDoctors service. Security: admin only',
      summary: 'Doctors',
      operationId: 'getAdminDoctors',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDoctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/doctors');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminDoctorsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for adminDoctors service. Security: admin only',
      summary: 'POST Doctors',
      operationId: 'postAdminDoctors',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDoctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/doctors');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminDoctorsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminDoctors service. Security: admin only',
      summary: 'Get adminDoctors by ID',
      operationId: 'getAdminDoctors_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDoctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/doctors/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminDoctorsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for adminDoctors service. Security: admin only',
      summary: 'Update adminDoctors by ID',
      operationId: 'putAdminDoctors',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDoctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/doctors/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1AdminDoctorsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for adminDoctors service. Security: admin only',
      summary: 'Delete adminDoctors by ID',
      operationId: 'deleteAdminDoctors',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDoctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/doctors/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminDoctorsEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminDoctors service. Security: admin only',
      summary: 'Endpoint5',
      operationId: 'getAdminDoctorsEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminDoctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/doctors/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint10Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint10',
      operationId: 'getAdminEndpoint10',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint10');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint11Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint11',
      operationId: 'getAdminEndpoint11',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint11');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint12Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint12',
      operationId: 'getAdminEndpoint12',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint12');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint13Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint13',
      operationId: 'getAdminEndpoint13',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint13');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint14Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint14',
      operationId: 'getAdminEndpoint14',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint14');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint15Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint15',
      operationId: 'getAdminEndpoint15',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint15');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint16Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint16',
      operationId: 'getAdminEndpoint16',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint16');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint17Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint17',
      operationId: 'getAdminEndpoint17',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint17');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint18Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint18',
      operationId: 'getAdminEndpoint18',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint18');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint19Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint19',
      operationId: 'getAdminEndpoint19',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint19');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint20Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint20',
      operationId: 'getAdminEndpoint20',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint20');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint21Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint21',
      operationId: 'getAdminEndpoint21',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint21');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint5',
      operationId: 'getAdminEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint6',
      operationId: 'getAdminEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint7',
      operationId: 'getAdminEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint8',
      operationId: 'getAdminEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for admin service. Security: admin only',
      summary: 'Endpoint9',
      operationId: 'getAdminEndpoint9',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["admin"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminNotificationsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Notifications',
      operationId: 'getAdminNotifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminNotificationsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for adminNotifications service. Security: admin only',
      summary: 'POST Notifications',
      operationId: 'postAdminNotifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminNotificationsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Get adminNotifications by ID',
      operationId: 'getAdminNotifications_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AdminNotificationsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for adminNotifications service. Security: admin only',
      summary: 'Update adminNotifications by ID',
      operationId: 'putAdminNotifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1AdminNotificationsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for adminNotifications service. Security: admin only',
      summary: 'Delete adminNotifications by ID',
      operationId: 'deleteAdminNotifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminNotificationsEndpoint10Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Endpoint10',
      operationId: 'getAdminNotificationsEndpoint10',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/endpoint10');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminNotificationsEndpoint11Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Endpoint11',
      operationId: 'getAdminNotificationsEndpoint11',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/endpoint11');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminNotificationsEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Endpoint5',
      operationId: 'getAdminNotificationsEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminNotificationsEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Endpoint6',
      operationId: 'getAdminNotificationsEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminNotificationsEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Endpoint7',
      operationId: 'getAdminNotificationsEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminNotificationsEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Endpoint8',
      operationId: 'getAdminNotificationsEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AdminNotificationsEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for adminNotifications service. Security: admin only',
      summary: 'Endpoint9',
      operationId: 'getAdminNotificationsEndpoint9',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["adminNotifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/admin/notifications/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AnalyticsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for analytics service. Security: admin + manager',
      summary: 'List analytics',
      operationId: 'getAnalytics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AnalyticsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for analytics service. Security: admin + manager',
      summary: 'Create analytics',
      operationId: 'postAnalytics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AnalyticsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for analytics service. Security: admin + manager',
      summary: 'Get analytics by ID',
      operationId: 'getAnalytics_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AnalyticsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for analytics service. Security: admin + manager',
      summary: 'Update analytics by ID',
      operationId: 'putAnalytics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1AnalyticsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for analytics service. Security: admin + manager',
      summary: 'Delete analytics by ID',
      operationId: 'deleteAnalytics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AnalyticsEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for analytics service. Security: admin + manager',
      summary: 'Endpoint5',
      operationId: 'getAnalyticsEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AnalyticsEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for analytics service. Security: admin + manager',
      summary: 'Endpoint6',
      operationId: 'getAnalyticsEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AnalyticsEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for analytics service. Security: admin + manager',
      summary: 'Endpoint7',
      operationId: 'getAnalyticsEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AnalyticsEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for analytics service. Security: admin + manager',
      summary: 'Endpoint8',
      operationId: 'getAnalyticsEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AnalyticsEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for analytics service. Security: admin + manager',
      summary: 'Endpoint9',
      operationId: 'getAnalyticsEndpoint9',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["analytics"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/analytics/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AppointmentsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'List appointments',
      operationId: 'getAppointments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for appointments service. Security: multi-role',
      summary: 'Create appointments',
      operationId: 'postAppointments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Get appointments by ID',
      operationId: 'getAppointments_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for appointments service. Security: multi-role',
      summary: 'Update appointments by ID',
      operationId: 'putAppointments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1AppointmentsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for appointments service. Security: multi-role',
      summary: 'Delete appointments by ID',
      operationId: 'deleteAppointments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AppointmentsBookGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Book',
      operationId: 'getAppointmentsBook',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/book');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsBookPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for appointments service. Security: multi-role',
      summary: 'POST Book',
      operationId: 'postAppointmentsBook',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/book');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AppointmentsCalendarGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Calendar',
      operationId: 'getAppointmentsCalendar',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/calendar');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsCancelIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Get appointments by ID',
      operationId: 'getAppointmentsCancel',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/cancel/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsCancelIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for appointments service. Security: multi-role',
      summary: 'Update appointments by ID',
      operationId: 'putAppointmentsCancel',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/cancel/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsCompleteIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Get appointments by ID',
      operationId: 'getAppointmentsComplete',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/complete/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsCompleteIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for appointments service. Security: multi-role',
      summary: 'Update appointments by ID',
      operationId: 'putAppointmentsComplete',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/complete/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsConfirmIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Get appointments by ID',
      operationId: 'getAppointmentsConfirm',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/confirm/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsConfirmIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for appointments service. Security: multi-role',
      summary: 'Update appointments by ID',
      operationId: 'putAppointmentsConfirm',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/confirm/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsNoShowIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Get appointments by ID',
      operationId: 'getAppointmentsNoshow',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/no-show/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsNoShowIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for appointments service. Security: multi-role',
      summary: 'Update appointments by ID',
      operationId: 'putAppointmentsNoshow',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/no-show/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AppointmentsPastGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Past',
      operationId: 'getAppointmentsPast',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/past');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsRescheduleIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Get appointments by ID',
      operationId: 'getAppointmentsReschedule',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/reschedule/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AppointmentsRescheduleIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for appointments service. Security: multi-role',
      summary: 'Update appointments by ID',
      operationId: 'putAppointmentsReschedule',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/reschedule/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AppointmentsSlotsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Slots',
      operationId: 'getAppointmentsSlots',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/slots');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AppointmentsTodayGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Today',
      operationId: 'getAppointmentsToday',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/today');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AppointmentsUpcomingGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for appointments service. Security: multi-role',
      summary: 'Upcoming',
      operationId: 'getAppointmentsUpcoming',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["appointments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/appointments/upcoming');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1Auth2faDisableGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Disable',
      operationId: 'getAuth2faDisable',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/2fa/disable');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1Auth2faEnableGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Enable',
      operationId: 'getAuth2faEnable',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/2fa/enable');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1Auth2faVerifyGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Verify',
      operationId: 'getAuth2faVerify',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/2fa/verify');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthChangePasswordGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Change Password',
      operationId: 'getAuthChangepassword',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/change-password');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseCustomTokenGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Custom Token',
      operationId: 'getAuthFirebaseCustomtoken',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/custom-token');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseDeleteAccountGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Delete Account',
      operationId: 'getAuthFirebaseDeleteaccount',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/delete-account');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseLinkProviderGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Link Provider',
      operationId: 'getAuthFirebaseLinkprovider',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/link-provider');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseLoginGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Login',
      operationId: 'getAuthFirebaseLogin',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/login');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseLogoutGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Logout',
      operationId: 'getAuthFirebaseLogout',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/logout');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseProfileGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Profile',
      operationId: 'getAuthFirebaseProfile',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/profile');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseProvidersGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Providers',
      operationId: 'getAuthFirebaseProviders',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/providers');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseRefreshGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Refresh',
      operationId: 'getAuthFirebaseRefresh',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/refresh');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseSendVerificationGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Send Verification',
      operationId: 'getAuthFirebaseSendverification',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/send-verification');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AuthFirebaseSendVerificationPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for auth service. Security: public + admin',
      summary: 'POST Send Verification',
      operationId: 'postAuthFirebaseSendverification',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/send-verification');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseUnlinkProviderGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Unlink Provider',
      operationId: 'getAuthFirebaseUnlinkprovider',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/unlink-provider');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseUpdateProfileGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Update Profile',
      operationId: 'getAuthFirebaseUpdateprofile',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/update-profile');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseVerifyGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Verify',
      operationId: 'getAuthFirebaseVerify',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/verify');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthFirebaseVerifyEmailGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Verify Email',
      operationId: 'getAuthFirebaseVerifyemail',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/firebase/verify-email');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthForgotPasswordGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Forgot Password',
      operationId: 'getAuthForgotpassword',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/forgot-password');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthLoginGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Login',
      operationId: 'getAuthLogin',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/login');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthLogoutGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Logout',
      operationId: 'getAuthLogout',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/logout');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpDevGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Otp Dev',
      operationId: 'getAuthOtpdev',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp-dev');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AuthOtpDevPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for auth service. Security: public + admin',
      summary: 'POST Otp Dev',
      operationId: 'postAuthOtpdev',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp-dev');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AuthOtpDevIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Get auth by ID',
      operationId: 'getAuthOtpdev_2',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp-dev/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1AuthOtpDevIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for auth service. Security: public + admin',
      summary: 'Update auth by ID',
      operationId: 'putAuthOtpdev',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp-dev/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1AuthOtpDevIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'DELETE endpoint for auth service. Security: public + admin',
      summary: 'Delete auth by ID',
      operationId: 'deleteAuthOtpdev',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp-dev/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpDevEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Endpoint5',
      operationId: 'getAuthOtpdevEndpoint5',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp-dev/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpDevEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Endpoint6',
      operationId: 'getAuthOtpdevEndpoint6',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp-dev/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpDevEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Endpoint7',
      operationId: 'getAuthOtpdevEndpoint7',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp-dev/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpAnalyticsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Analytics',
      operationId: 'getAuthOtpAnalytics',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/analytics');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpBlockGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Block',
      operationId: 'getAuthOtpBlock',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/block');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpCleanupGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Cleanup',
      operationId: 'getAuthOtpCleanup',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/cleanup');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpHistoryGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'History',
      operationId: 'getAuthOtpHistory',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/history');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpRateLimitGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Rate Limit',
      operationId: 'getAuthOtpRatelimit',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/rate-limit');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpResendGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Resend',
      operationId: 'getAuthOtpResend',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/resend');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AuthOtpResendPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for auth service. Security: public + admin',
      summary: 'POST Resend',
      operationId: 'postAuthOtpResend',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/resend');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpSendGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Send',
      operationId: 'getAuthOtpSend',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/send');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1AuthOtpSendPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for auth service. Security: public + admin',
      summary: 'POST Send',
      operationId: 'postAuthOtpSend',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/send');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpSettingsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Settings',
      operationId: 'getAuthOtpSettings',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/settings');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpStatusGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Status',
      operationId: 'getAuthOtpStatus',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/status');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpUnblockGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Unblock',
      operationId: 'getAuthOtpUnblock',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/unblock');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpValidateGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Validate',
      operationId: 'getAuthOtpValidate',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/validate');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthOtpVerifyGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Verify',
      operationId: 'getAuthOtpVerify',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/otp/verify');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthProfileGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Profile',
      operationId: 'getAuthProfile',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/profile');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthRefreshGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Refresh',
      operationId: 'getAuthRefresh',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/refresh');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthRegisterGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Register',
      operationId: 'getAuthRegister',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/register');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthResetPasswordGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Reset Password',
      operationId: 'getAuthResetpassword',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/reset-password');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthRevokeGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Revoke',
      operationId: 'getAuthRevoke',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/revoke');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthSessionsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Sessions',
      operationId: 'getAuthSessions',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/sessions');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthValidateGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Validate',
      operationId: 'getAuthValidate',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/validate');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1AuthVerifyGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for auth service. Security: public + admin',
      summary: 'Verify',
      operationId: 'getAuthVerify',
      consumes: [],
      produces: [],
      security: [],
      tags: ["auth"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/auth/verify');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DebugGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for debug service. Security: admin only',
      summary: 'List debug',
      operationId: 'getDebug',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1DebugPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for debug service. Security: admin only',
      summary: 'Create debug',
      operationId: 'postDebug',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1DebugIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for debug service. Security: admin only',
      summary: 'Get debug by ID',
      operationId: 'getDebug_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1DebugIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for debug service. Security: admin only',
      summary: 'Update debug by ID',
      operationId: 'putDebug',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1DebugIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'DELETE endpoint for debug service. Security: admin only',
      summary: 'Delete debug by ID',
      operationId: 'deleteDebug',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DebugEndpoint10Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for debug service. Security: admin only',
      summary: 'Endpoint10',
      operationId: 'getDebugEndpoint10',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/endpoint10');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DebugEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for debug service. Security: admin only',
      summary: 'Endpoint5',
      operationId: 'getDebugEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DebugEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for debug service. Security: admin only',
      summary: 'Endpoint6',
      operationId: 'getDebugEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DebugEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for debug service. Security: admin only',
      summary: 'Endpoint7',
      operationId: 'getDebugEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DebugEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for debug service. Security: admin only',
      summary: 'Endpoint8',
      operationId: 'getDebugEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DebugEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for debug service. Security: admin only',
      summary: 'Endpoint9',
      operationId: 'getDebugEndpoint9',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["debug"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/debug/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'List departments',
      operationId: 'getDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1DepartmentsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for departments service. Security: staff + admin',
      summary: 'Create departments',
      operationId: 'postDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1DepartmentsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Get departments by ID',
      operationId: 'getDepartments_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1DepartmentsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for departments service. Security: staff + admin',
      summary: 'Update departments by ID',
      operationId: 'putDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1DepartmentsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for departments service. Security: staff + admin',
      summary: 'Delete departments by ID',
      operationId: 'deleteDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint10Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint10',
      operationId: 'getDepartmentsEndpoint10',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint10');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint11Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint11',
      operationId: 'getDepartmentsEndpoint11',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint11');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint12Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint12',
      operationId: 'getDepartmentsEndpoint12',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint12');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint13Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint13',
      operationId: 'getDepartmentsEndpoint13',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint13');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint5',
      operationId: 'getDepartmentsEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint6',
      operationId: 'getDepartmentsEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint7',
      operationId: 'getDepartmentsEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint8',
      operationId: 'getDepartmentsEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DepartmentsEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for departments service. Security: staff + admin',
      summary: 'Endpoint9',
      operationId: 'getDepartmentsEndpoint9',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["departments"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/departments/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DevicesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for devices service. Security: user-based',
      summary: 'List devices',
      operationId: 'getDevices',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1DevicesPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for devices service. Security: user-based',
      summary: 'Create devices',
      operationId: 'postDevices',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1DevicesIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for devices service. Security: user-based',
      summary: 'Get devices by ID',
      operationId: 'getDevices_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1DevicesIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for devices service. Security: user-based',
      summary: 'Update devices by ID',
      operationId: 'putDevices',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1DevicesIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'DELETE endpoint for devices service. Security: user-based',
      summary: 'Delete devices by ID',
      operationId: 'deleteDevices',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DevicesEndpoint10Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for devices service. Security: user-based',
      summary: 'Endpoint10',
      operationId: 'getDevicesEndpoint10',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/endpoint10');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DevicesEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for devices service. Security: user-based',
      summary: 'Endpoint5',
      operationId: 'getDevicesEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DevicesEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for devices service. Security: user-based',
      summary: 'Endpoint6',
      operationId: 'getDevicesEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DevicesEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for devices service. Security: user-based',
      summary: 'Endpoint7',
      operationId: 'getDevicesEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DevicesEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for devices service. Security: user-based',
      summary: 'Endpoint8',
      operationId: 'getDevicesEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DevicesEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for devices service. Security: user-based',
      summary: 'Endpoint9',
      operationId: 'getDevicesEndpoint9',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["devices"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/devices/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'List doctors',
      operationId: 'getDoctors',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1DoctorsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for doctors service. Security: multi-role',
      summary: 'Create doctors',
      operationId: 'postDoctors',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1DoctorsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Get doctors by ID',
      operationId: 'getDoctors_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1DoctorsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for doctors service. Security: multi-role',
      summary: 'Update doctors by ID',
      operationId: 'putDoctors',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1DoctorsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'DELETE endpoint for doctors service. Security: multi-role',
      summary: 'Delete doctors by ID',
      operationId: 'deleteDoctors',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint10Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint10',
      operationId: 'getDoctorsEndpoint10',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint10');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint11Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint11',
      operationId: 'getDoctorsEndpoint11',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint11');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint12Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint12',
      operationId: 'getDoctorsEndpoint12',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint12');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint13Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint13',
      operationId: 'getDoctorsEndpoint13',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint13');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint5',
      operationId: 'getDoctorsEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint6',
      operationId: 'getDoctorsEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint7',
      operationId: 'getDoctorsEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint8',
      operationId: 'getDoctorsEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1DoctorsEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for doctors service. Security: multi-role',
      summary: 'Endpoint9',
      operationId: 'getDoctorsEndpoint9',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["doctors"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/doctors/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1FeedbackGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'List feedback',
      operationId: 'getFeedback',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1FeedbackPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for feedback service. Security: all users',
      summary: 'Create feedback',
      operationId: 'postFeedback',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1FeedbackIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'Get feedback by ID',
      operationId: 'getFeedback_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1FeedbackIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for feedback service. Security: all users',
      summary: 'Update feedback by ID',
      operationId: 'putFeedback',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1FeedbackIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'DELETE endpoint for feedback service. Security: all users',
      summary: 'Delete feedback by ID',
      operationId: 'deleteFeedback',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1FeedbackEndpoint10Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'Endpoint10',
      operationId: 'getFeedbackEndpoint10',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/endpoint10');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1FeedbackEndpoint11Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'Endpoint11',
      operationId: 'getFeedbackEndpoint11',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/endpoint11');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1FeedbackEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'Endpoint5',
      operationId: 'getFeedbackEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1FeedbackEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'Endpoint6',
      operationId: 'getFeedbackEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1FeedbackEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'Endpoint7',
      operationId: 'getFeedbackEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1FeedbackEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'Endpoint8',
      operationId: 'getFeedbackEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1FeedbackEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for feedback service. Security: all users',
      summary: 'Endpoint9',
      operationId: 'getFeedbackEndpoint9',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["feedback"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/feedback/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthGet({
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'List health',
      operationId: 'getHealth',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for health service. Security: public + protected',
      summary: 'Create health',
      operationId: 'postHealth',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Health Records',
      operationId: 'getHealthrecords',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'POST Health Records',
      operationId: 'postHealthrecords',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecords_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecords',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1HealthRecordsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Delete healthRecords by ID',
      operationId: 'deleteHealthrecords',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsAnalyticsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Analytics',
      operationId: 'getHealthrecordsAnalytics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/analytics');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsArchiveIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsArchive',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/archive/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsArchiveIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsArchive',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/archive/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsArchivedGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Archived',
      operationId: 'getHealthrecordsArchived',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/archived');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsAuditTrailIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsAudittrail',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/audit-trail/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsAuditTrailIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsAudittrail',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/audit-trail/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsBulkDownloadGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Bulk Download',
      operationId: 'getHealthrecordsBulkdownload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/bulk-download');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsBulkUploadGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Bulk Upload',
      operationId: 'getHealthrecordsBulkupload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/bulk-upload');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsBulkUploadPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'POST Bulk Upload',
      operationId: 'postHealthrecordsBulkupload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/bulk-upload');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsCategoriesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Categories',
      operationId: 'getHealthrecordsCategories',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/categories');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsCleanupGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Cleanup',
      operationId: 'getHealthrecordsCleanup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/cleanup');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsCopyIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsCopy',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/copy/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsCopyIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsCopy',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/copy/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsDownloadIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsDownload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/download/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsDownloadIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsDownload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/download/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsExportGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Export',
      operationId: 'getHealthrecordsExport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/export');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsFoldersGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Folders',
      operationId: 'getHealthrecordsFolders',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/folders');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsFoldersIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsFolders_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/folders/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsFoldersIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsFolders',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/folders/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsImportGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Import',
      operationId: 'getHealthrecordsImport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/import');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsMetadataIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsMetadata',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/metadata/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsMetadataIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsMetadata',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/metadata/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsMigrateGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Migrate',
      operationId: 'getHealthrecordsMigrate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/migrate');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsMoveIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsMove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/move/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsMoveIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsMove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/move/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsPermanentDeleteIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsPermanentdelete',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/permanent-delete/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsPermanentDeleteIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsPermanentdelete',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/permanent-delete/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsPermissionsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsPermissions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/permissions/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsPermissionsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsPermissions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/permissions/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsRecentGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Recent',
      operationId: 'getHealthrecordsRecent',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/recent');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsRestoreIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsRestore',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/restore/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsRestoreIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsRestore',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/restore/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsSearchGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Search',
      operationId: 'getHealthrecordsSearch',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/search');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsShareIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsShare',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/share/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsShareIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsShare',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/share/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsStorageUsageGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Storage Usage',
      operationId: 'getHealthrecordsStorageusage',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/storage-usage');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsTagsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Tags',
      operationId: 'getHealthrecordsTags',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/tags');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsTagsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsTags_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/tags/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsTagsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsTags',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/tags/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsTemplatesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Templates',
      operationId: 'getHealthrecordsTemplates',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/templates');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsUnarchiveIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsUnarchive',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/unarchive/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsUnarchiveIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsUnarchive',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/unarchive/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthRecordsUploadGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Upload',
      operationId: 'getHealthrecordsUpload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/upload');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsUploadPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'POST Upload',
      operationId: 'postHealthrecordsUpload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/upload');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsVersionsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Get healthRecords by ID',
      operationId: 'getHealthrecordsVersions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/versions/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthRecordsVersionsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for healthRecords service. Security: hipaa-compliant',
      summary: 'Update healthRecords by ID',
      operationId: 'putHealthrecordsVersions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["healthRecords"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health-records/versions/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Get health by ID',
      operationId: 'getHealth_2',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1HealthIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for health service. Security: public + protected',
      summary: 'Update health by ID',
      operationId: 'putHealth',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1HealthIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for health service. Security: public + protected',
      summary: 'Delete health by ID',
      operationId: 'deleteHealth',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint10Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint10',
      operationId: 'getHealthEndpoint10',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint10');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint11Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint11',
      operationId: 'getHealthEndpoint11',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint11');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint12Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint12',
      operationId: 'getHealthEndpoint12',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint12');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint13Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint13',
      operationId: 'getHealthEndpoint13',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint13');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint5',
      operationId: 'getHealthEndpoint5',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint6',
      operationId: 'getHealthEndpoint6',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint7',
      operationId: 'getHealthEndpoint7',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint8',
      operationId: 'getHealthEndpoint8',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1HealthEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for health service. Security: public + protected',
      summary: 'Endpoint9',
      operationId: 'getHealthEndpoint9',
      consumes: [],
      produces: [],
      security: [],
      tags: ["health"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/health/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'List investigations',
      operationId: 'getInvestigations',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for investigations service. Security: lab + medical',
      summary: 'Create investigations',
      operationId: 'postInvestigations',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigations_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigations',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1InvestigationsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for investigations service. Security: lab + medical',
      summary: 'Delete investigations by ID',
      operationId: 'deleteInvestigations',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsAbnormalResultsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Abnormal Results',
      operationId: 'getInvestigationsAbnormalresults',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/abnormal-results');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsAnalyticsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Analytics',
      operationId: 'getInvestigationsAnalytics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/analytics');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsApproveIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsApprove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/approve/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsApproveIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsApprove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/approve/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsCategoriesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Categories',
      operationId: 'getInvestigationsCategories',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/categories');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsCompletedGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Completed',
      operationId: 'getInvestigationsCompleted',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/completed');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsCriticalValuesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Critical Values',
      operationId: 'getInvestigationsCriticalvalues',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/critical-values');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsDownloadResultIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsDownloadresult',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/download-result/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsDownloadResultIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsDownloadresult',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/download-result/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsFollowUpIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsFollowup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/follow-up/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsFollowUpIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsFollowup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/follow-up/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsHistoryGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'History',
      operationId: 'getInvestigationsHistory',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/history');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsNotesIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsNotes',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/notes/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsNotesIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsNotes',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/notes/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsPackagesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Packages',
      operationId: 'getInvestigationsPackages',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/packages');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsPackagesIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsPackages_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/packages/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsPackagesIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsPackages',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/packages/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsPendingGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Pending',
      operationId: 'getInvestigationsPending',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/pending');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsRejectIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsReject',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/reject/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsRejectIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsReject',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/reject/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsRequestGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Request',
      operationId: 'getInvestigationsRequest',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/request');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsResultsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsResults',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/results/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsResultsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsResults',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/results/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsRetestIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsRetest',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/retest/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsRetestIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsRetest',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/retest/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsShareResultIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsShareresult',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/share-result/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsShareResultIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsShareresult',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/share-result/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsTestsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Tests',
      operationId: 'getInvestigationsTests',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/tests');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsTestsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsTests_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/tests/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsTestsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsTests',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/tests/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1InvestigationsTrendsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Trends',
      operationId: 'getInvestigationsTrends',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/trends');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsUploadResultIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for investigations service. Security: lab + medical',
      summary: 'Get investigations by ID',
      operationId: 'getInvestigationsUploadresult',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/upload-result/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1InvestigationsUploadResultIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for investigations service. Security: lab + medical',
      summary: 'Update investigations by ID',
      operationId: 'putInvestigationsUploadresult',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["investigations"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/investigations/upload-result/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1LookupGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for lookup service. Security: staff + admin',
      summary: 'List lookup',
      operationId: 'getLookup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1LookupPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for lookup service. Security: staff + admin',
      summary: 'Create lookup',
      operationId: 'postLookup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1LookupIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for lookup service. Security: staff + admin',
      summary: 'Get lookup by ID',
      operationId: 'getLookup_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1LookupIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for lookup service. Security: staff + admin',
      summary: 'Update lookup by ID',
      operationId: 'putLookup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1LookupIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for lookup service. Security: staff + admin',
      summary: 'Delete lookup by ID',
      operationId: 'deleteLookup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1LookupEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for lookup service. Security: staff + admin',
      summary: 'Endpoint5',
      operationId: 'getLookupEndpoint5',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1LookupEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for lookup service. Security: staff + admin',
      summary: 'Endpoint6',
      operationId: 'getLookupEndpoint6',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1LookupEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for lookup service. Security: staff + admin',
      summary: 'Endpoint7',
      operationId: 'getLookupEndpoint7',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1LookupEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for lookup service. Security: staff + admin',
      summary: 'Endpoint8',
      operationId: 'getLookupEndpoint8',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["lookup"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/lookup/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'List notifications',
      operationId: 'getNotifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for notifications service. Security: role-based',
      summary: 'Create notifications',
      operationId: 'postNotifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Get notifications by ID',
      operationId: 'getNotifications_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for notifications service. Security: role-based',
      summary: 'Update notifications by ID',
      operationId: 'putNotifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1NotificationsIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for notifications service. Security: role-based',
      summary: 'Delete notifications by ID',
      operationId: 'deleteNotifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsBulkSendGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Bulk Send',
      operationId: 'getNotificationsBulksend',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/bulk-send');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsBulkSendPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for notifications service. Security: role-based',
      summary: 'POST Bulk Send',
      operationId: 'postNotificationsBulksend',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/bulk-send');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsCancelIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Get notifications by ID',
      operationId: 'getNotificationsCancel',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/cancel/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsCancelIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for notifications service. Security: role-based',
      summary: 'Update notifications by ID',
      operationId: 'putNotificationsCancel',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/cancel/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsDevicesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Devices',
      operationId: 'getNotificationsDevices',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/devices');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsHistoryGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'History',
      operationId: 'getNotificationsHistory',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/history');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsMarkAllReadGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Mark All Read',
      operationId: 'getNotificationsMarkallread',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/mark-all-read');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsMarkReadIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Get notifications by ID',
      operationId: 'getNotificationsMarkread',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/mark-read/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsMarkReadIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for notifications service. Security: role-based',
      summary: 'Update notifications by ID',
      operationId: 'putNotificationsMarkread',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/mark-read/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsPreferencesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Preferences',
      operationId: 'getNotificationsPreferences',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/preferences');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsPreferencesUserIdGet({
    required String? userId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Preferences',
      operationId: 'getNotificationsPreferences_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/preferences/${userId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsScheduleGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Schedule',
      operationId: 'getNotificationsSchedule',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/schedule');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsScheduleIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Get notifications by ID',
      operationId: 'getNotificationsSchedule_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/schedule/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsScheduleIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for notifications service. Security: role-based',
      summary: 'Update notifications by ID',
      operationId: 'putNotificationsSchedule',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/schedule/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsSendGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Send',
      operationId: 'getNotificationsSend',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/send');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsSendPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for notifications service. Security: role-based',
      summary: 'POST Send',
      operationId: 'postNotificationsSend',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/send');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsSubscribeTopicGet({
    required String? topic,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Subscribe',
      operationId: 'getNotificationsSubscribe',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/subscribe/${topic}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsTemplatesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Templates',
      operationId: 'getNotificationsTemplates',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/templates');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsTemplatesIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Get notifications by ID',
      operationId: 'getNotificationsTemplates_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/templates/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1NotificationsTemplatesIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for notifications service. Security: role-based',
      summary: 'Update notifications by ID',
      operationId: 'putNotificationsTemplates',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/templates/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsTestGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Test',
      operationId: 'getNotificationsTest',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/test');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsTopicsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Topics',
      operationId: 'getNotificationsTopics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/topics');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsUnreadGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Unread',
      operationId: 'getNotificationsUnread',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/unread');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1NotificationsUnsubscribeTopicGet({
    required String? topic,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for notifications service. Security: role-based',
      summary: 'Unsubscribe',
      operationId: 'getNotificationsUnsubscribe',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["notifications"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/notifications/unsubscribe/${topic}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyAlternativesMedicineIdGet({
    required String? medicineId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Alternatives',
      operationId: 'getPharmacyAlternatives',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/alternatives/${medicineId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyAvailabilityMedicineIdGet({
    required String? medicineId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Availability',
      operationId: 'getPharmacyAvailability',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/availability/${medicineId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyCartGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Cart',
      operationId: 'getPharmacyCart',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/cart');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyCartAddGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Add',
      operationId: 'getPharmacyCartAdd',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/cart/add');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyCartAddPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'POST Add',
      operationId: 'postPharmacyCartAdd',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/cart/add');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyCartClearGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Clear',
      operationId: 'getPharmacyCartClear',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/cart/clear');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyCartRemoveIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Get pharmacy by ID',
      operationId: 'getPharmacyCartRemove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/cart/remove/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyCartRemoveIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Update pharmacy by ID',
      operationId: 'putPharmacyCartRemove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/cart/remove/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyCheckoutGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Checkout',
      operationId: 'getPharmacyCheckout',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/checkout');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyDeliveryAddressGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Delivery Address',
      operationId: 'getPharmacyDeliveryaddress',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/delivery-address');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyDeliveryAddressPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'POST Delivery Address',
      operationId: 'postPharmacyDeliveryaddress',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/delivery-address');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyDeliverySlotsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Delivery Slots',
      operationId: 'getPharmacyDeliveryslots',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/delivery-slots');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyFavoritesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Favorites',
      operationId: 'getPharmacyFavorites',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/favorites');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyFeedbackOrderIdGet({
    required String? orderId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Feedback',
      operationId: 'getPharmacyFeedback',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/feedback/${orderId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyHistoryGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'History',
      operationId: 'getPharmacyHistory',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/history');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyInteractionsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Interactions',
      operationId: 'getPharmacyInteractions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/interactions');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyMedicinesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Medicines',
      operationId: 'getPharmacyMedicines',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/medicines');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyMedicinesIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Get pharmacy by ID',
      operationId: 'getPharmacyMedicines_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/medicines/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyMedicinesIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Update pharmacy by ID',
      operationId: 'putPharmacyMedicines',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/medicines/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyOrdersGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Orders',
      operationId: 'getPharmacyOrders',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/orders');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyOrdersIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Get pharmacy by ID',
      operationId: 'getPharmacyOrders_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/orders/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyOrdersIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Update pharmacy by ID',
      operationId: 'putPharmacyOrders',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/orders/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyPaymentOrderIdGet({
    required String? orderId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Payment',
      operationId: 'getPharmacyPayment',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/payment/${orderId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyPrescriptionsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Prescriptions',
      operationId: 'getPharmacyPrescriptions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/prescriptions');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyPrescriptionsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Get pharmacy by ID',
      operationId: 'getPharmacyPrescriptions_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/prescriptions/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyPrescriptionsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Update pharmacy by ID',
      operationId: 'putPharmacyPrescriptions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/prescriptions/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyRecurringGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Recurring',
      operationId: 'getPharmacyRecurring',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/recurring');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyRecurringIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Get pharmacy by ID',
      operationId: 'getPharmacyRecurring_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/recurring/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyRecurringIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Update pharmacy by ID',
      operationId: 'putPharmacyRecurring',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/recurring/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyRefillPrescriptionIdGet({
    required String? prescriptionId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Refill',
      operationId: 'getPharmacyRefill',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/refill/${prescriptionId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyReturnsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Returns',
      operationId: 'getPharmacyReturns',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/returns');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyReturnsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Get pharmacy by ID',
      operationId: 'getPharmacyReturns_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/returns/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyReturnsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Update pharmacy by ID',
      operationId: 'putPharmacyReturns',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/returns/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyTrackOrderIdGet({
    required String? orderId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Track',
      operationId: 'getPharmacyTrack',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/track/${orderId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1PharmacyUploadPrescriptionGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Upload Prescription',
      operationId: 'getPharmacyUploadprescription',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/upload-prescription');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyUploadPrescriptionPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'POST Upload Prescription',
      operationId: 'postPharmacyUploadprescription',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/upload-prescription');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyVerifyPrescriptionIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'GET endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Get pharmacy by ID',
      operationId: 'getPharmacyVerifyprescription',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/verify-prescription/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1PharmacyVerifyPrescriptionIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'PUT endpoint for pharmacy service. Security: pharmacy + medical',
      summary: 'Update pharmacy by ID',
      operationId: 'putPharmacyVerifyprescription',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["pharmacy"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/pharmacy/verify-prescription/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacAuditGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Audit',
      operationId: 'getRbacAudit',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/audit');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacBulkAssignGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Bulk Assign',
      operationId: 'getRbacBulkassign',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/bulk-assign');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacCheckPermissionGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Check Permission',
      operationId: 'getRbacCheckpermission',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/check-permission');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacCheckRoleGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Check Role',
      operationId: 'getRbacCheckrole',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/check-role');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacEffectivePermissionsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Effective Permissions',
      operationId: 'getRbacEffectivepermissions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/effective-permissions');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacExportGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Export',
      operationId: 'getRbacExport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/export');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacHierarchyGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Hierarchy',
      operationId: 'getRbacHierarchy',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/hierarchy');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacHistoryGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'History',
      operationId: 'getRbacHistory',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/history');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacImportGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Import',
      operationId: 'getRbacImport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/import');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacMatrixGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Matrix',
      operationId: 'getRbacMatrix',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/matrix');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacPermissionsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Permissions',
      operationId: 'getRbacPermissions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/permissions');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1RbacPermissionsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Get rbac by ID',
      operationId: 'getRbacPermissions_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/permissions/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1RbacPermissionsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for rbac service. Security: admin + security',
      summary: 'Update rbac by ID',
      operationId: 'putRbacPermissions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/permissions/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacRoleTemplatesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Role Templates',
      operationId: 'getRbacRoletemplates',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/role-templates');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacRolesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Roles',
      operationId: 'getRbacRoles',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/roles');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1RbacRolesIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Get rbac by ID',
      operationId: 'getRbacRoles_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/roles/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1RbacRolesIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for rbac service. Security: admin + security',
      summary: 'Update rbac by ID',
      operationId: 'putRbacRoles',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/roles/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacRolesRoleIdPermissionsGet({
    required String? roleId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Permissions',
      operationId: 'getRbacRolesPermissions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/roles/${roleId}/permissions');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacRolesRoleIdUsersGet({
    required String? roleId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Users',
      operationId: 'getRbacRolesUsers',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/roles/${roleId}/users');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacSyncGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Sync',
      operationId: 'getRbacSync',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/sync');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacUsersUserIdPermissionsGet({
    required String? userId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Permissions',
      operationId: 'getRbacUsersPermissions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/users/${userId}/permissions');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacUsersUserIdRolesGet({
    required String? userId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Roles',
      operationId: 'getRbacUsersRoles',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/users/${userId}/roles');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1RbacValidateGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for rbac service. Security: admin + security',
      summary: 'Validate',
      operationId: 'getRbacValidate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["rbac"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/rbac/validate');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosAllClearGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'All Clear',
      operationId: 'getSosAllclear',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/all-clear');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosAssignResponderAlertIdGet({
    required String? alertId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Assign Responder',
      operationId: 'getSosAssignresponder',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/assign-responder/${alertId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosAudioRecordGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Audio Record',
      operationId: 'getSosAudiorecord',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/audio-record');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosBulkAlertGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Bulk Alert',
      operationId: 'getSosBulkalert',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/bulk-alert');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosCancelGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Cancel',
      operationId: 'getSosCancel',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/cancel');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosContactsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Contacts',
      operationId: 'getSosContacts',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/contacts');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1SosContactsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Get sos by ID',
      operationId: 'getSosContacts_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/contacts/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1SosContactsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for sos service. Security: emergency system',
      summary: 'Update sos by ID',
      operationId: 'putSosContacts',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/contacts/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosDrillGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Drill',
      operationId: 'getSosDrill',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/drill');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1SosDrillIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Get sos by ID',
      operationId: 'getSosDrill_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/drill/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1SosDrillIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for sos service. Security: emergency system',
      summary: 'Update sos by ID',
      operationId: 'putSosDrill',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/drill/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosEmergencyCodesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Emergency Codes',
      operationId: 'getSosEmergencycodes',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/emergency-codes');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosEmergencyInfoGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Emergency Info',
      operationId: 'getSosEmergencyinfo',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/emergency-info');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosEscalateAlertIdGet({
    required String? alertId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Escalate',
      operationId: 'getSosEscalate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/escalate/${alertId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosEvacuationGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Evacuation',
      operationId: 'getSosEvacuation',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/evacuation');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosFalseAlarmAlertIdGet({
    required String? alertId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'False Alarm',
      operationId: 'getSosFalsealarm',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/false-alarm/${alertId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosFeedbackAlertIdGet({
    required String? alertId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Feedback',
      operationId: 'getSosFeedback',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/feedback/${alertId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosFollowUpAlertIdGet({
    required String? alertId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Follow Up',
      operationId: 'getSosFollowup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/follow-up/${alertId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosGeofenceGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Geofence',
      operationId: 'getSosGeofence',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/geofence');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosHeatmapGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Heatmap',
      operationId: 'getSosHeatmap',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/heatmap');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosHistoryGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'History',
      operationId: 'getSosHistory',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/history');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosIncidentReportAlertIdGet({
    required String? alertId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Incident Report',
      operationId: 'getSosIncidentreport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/incident-report/${alertId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosIntegrationAmbulanceGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Ambulance',
      operationId: 'getSosIntegrationAmbulance',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/integration/ambulance');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosIntegrationFireGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Fire',
      operationId: 'getSosIntegrationFire',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/integration/fire');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosIntegrationPoliceGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Police',
      operationId: 'getSosIntegrationPolice',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/integration/police');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1SosLiveTrackingIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Get sos by ID',
      operationId: 'getSosLivetracking',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/live-tracking/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1SosLiveTrackingIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for sos service. Security: emergency system',
      summary: 'Update sos by ID',
      operationId: 'putSosLivetracking',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/live-tracking/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosLocationGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Location',
      operationId: 'getSosLocation',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/location');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosMedicalInfoGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Medical Info',
      operationId: 'getSosMedicalinfo',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/medical-info');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosNearestHelpGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Nearest Help',
      operationId: 'getSosNearesthelp',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/nearest-help');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosPanicButtonActivateGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Activate',
      operationId: 'getSosPanicbuttonActivate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/panic-button/activate');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosPanicButtonDeactivateGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Deactivate',
      operationId: 'getSosPanicbuttonDeactivate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/panic-button/deactivate');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosProtocolsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Protocols',
      operationId: 'getSosProtocols',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/protocols');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosResolveAlertIdGet({
    required String? alertId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Resolve',
      operationId: 'getSosResolve',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/resolve/${alertId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosResourcesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Resources',
      operationId: 'getSosResources',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/resources');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosRespondersGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Responders',
      operationId: 'getSosResponders',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/responders');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosResponseTimesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Response Times',
      operationId: 'getSosResponsetimes',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/response-times');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosSafeWordGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Safe Word',
      operationId: 'getSosSafeword',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/safe-word');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosSettingsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Settings',
      operationId: 'getSosSettings',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/settings');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosStatisticsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Statistics',
      operationId: 'getSosStatistics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/statistics');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosStatusGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Status',
      operationId: 'getSosStatus',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/status');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosTestAlertGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Test Alert',
      operationId: 'getSosTestalert',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/test-alert');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosTrainingGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Training',
      operationId: 'getSosTraining',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/training');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosTriggerGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Trigger',
      operationId: 'getSosTrigger',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/trigger');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1SosTriggerPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for sos service. Security: emergency system',
      summary: 'POST Trigger',
      operationId: 'postSosTrigger',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/trigger');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosVideoRecordGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Video Record',
      operationId: 'getSosVideorecord',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/video-record');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1SosZoneAlertGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for sos service. Security: emergency system',
      summary: 'Zone Alert',
      operationId: 'getSosZonealert',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["sos"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/sos/zone-alert');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'List staff',
      operationId: 'getStaff',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for staff service. Security: hr + management',
      summary: 'Create staff',
      operationId: 'postStaff',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaff_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaff',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1StaffIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for staff service. Security: hr + management',
      summary: 'Delete staff by ID',
      operationId: 'deleteStaff',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffAnnouncementsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Announcements',
      operationId: 'getStaffAnnouncements',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/announcements');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffAttendanceGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Attendance',
      operationId: 'getStaffAttendance',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/attendance');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffAttendanceIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffAttendance_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/attendance/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffAttendanceIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffAttendance',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/attendance/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffAttendanceCheckInGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Check In',
      operationId: 'getStaffAttendanceCheckin',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/attendance/check-in');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffAttendanceCheckOutGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Check Out',
      operationId: 'getStaffAttendanceCheckout',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/attendance/check-out');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffBenefitsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Benefits',
      operationId: 'getStaffBenefits',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/benefits');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffBenefitsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffBenefits_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/benefits/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffBenefitsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffBenefits',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/benefits/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffCertificationsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Certifications',
      operationId: 'getStaffCertifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/certifications');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffCertificationsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffCertifications_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/certifications/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffCertificationsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffCertifications',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/certifications/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffDepartmentsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Departments',
      operationId: 'getStaffDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/departments');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffDepartmentsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffDepartments_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/departments/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffDepartmentsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffDepartments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/departments/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffDocumentsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Documents',
      operationId: 'getStaffDocuments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/documents');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffDocumentsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffDocuments_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/documents/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffDocumentsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffDocuments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/documents/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffEmergencyContactsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffEmergencycontacts',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/emergency-contacts/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffEmergencyContactsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffEmergencycontacts',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/emergency-contacts/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffLeavesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Leaves',
      operationId: 'getStaffLeaves',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffLeavesIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffLeaves_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffLeavesIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffLeaves',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffLeavesApplyGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Apply',
      operationId: 'getStaffLeavesApply',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves/apply');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffLeavesApplyPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for staff service. Security: hr + management',
      summary: 'POST Apply',
      operationId: 'postStaffLeavesApply',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves/apply');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffLeavesApproveIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffLeavesApprove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves/approve/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffLeavesApproveIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffLeavesApprove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves/approve/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffLeavesRejectIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffLeavesReject',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves/reject/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffLeavesRejectIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffLeavesReject',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/leaves/reject/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffOvertimeGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Overtime',
      operationId: 'getStaffOvertime',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/overtime');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffOvertimeIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffOvertime_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/overtime/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffOvertimeIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffOvertime',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/overtime/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffPayrollGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Payroll',
      operationId: 'getStaffPayroll',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/payroll');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffPayrollIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffPayroll_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/payroll/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffPayrollIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffPayroll',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/payroll/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffPerformanceGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Performance',
      operationId: 'getStaffPerformance',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/performance');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffPerformanceIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffPerformance_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/performance/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffPerformanceIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffPerformance',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/performance/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffPoliciesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Policies',
      operationId: 'getStaffPolicies',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/policies');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffProfileIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffProfile',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/profile/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffProfileIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffProfile',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/profile/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffScheduleGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Schedule',
      operationId: 'getStaffSchedule',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/schedule');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffScheduleIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffSchedule_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/schedule/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffScheduleIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffSchedule',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/schedule/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffShiftsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Shifts',
      operationId: 'getStaffShifts',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/shifts');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffShiftsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffShifts_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/shifts/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffShiftsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffShifts',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/shifts/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1StaffTrainingGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Training',
      operationId: 'getStaffTraining',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/training');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffTrainingIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for staff service. Security: hr + management',
      summary: 'Get staff by ID',
      operationId: 'getStaffTraining_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/training/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1StaffTrainingIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for staff service. Security: hr + management',
      summary: 'Update staff by ID',
      operationId: 'putStaffTraining',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["staff"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/staff/training/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'List upload',
      operationId: 'getUpload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UploadPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for upload service. Security: role-based',
      summary: 'Create upload',
      operationId: 'postUpload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadArchiveFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Archive',
      operationId: 'getUploadArchive',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/archive/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadCancelUploadIdGet({
    required String? uploadId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Cancel',
      operationId: 'getUploadCancel',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/cancel/${uploadId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadChunkGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Chunk',
      operationId: 'getUploadChunk',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/chunk');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadChunkUploadIdGet({
    required String? uploadId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Chunk',
      operationId: 'getUploadChunk_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/chunk/${uploadId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadCleanupGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Cleanup',
      operationId: 'getUploadCleanup',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/cleanup');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadCompressGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Compress',
      operationId: 'getUploadCompress',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/compress');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadConvertFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Convert',
      operationId: 'getUploadConvert',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/convert/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadCopyFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Copy',
      operationId: 'getUploadCopy',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/copy/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadDecompressFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Decompress',
      operationId: 'getUploadDecompress',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/decompress/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadDecryptFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Decrypt',
      operationId: 'getUploadDecrypt',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/decrypt/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadDeleteFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Delete',
      operationId: 'getUploadDelete',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/delete/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadDownloadFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Download',
      operationId: 'getUploadDownload',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/download/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadEncryptFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Encrypt',
      operationId: 'getUploadEncrypt',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/encrypt/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadExtractTextFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Extract Text',
      operationId: 'getUploadExtracttext',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/extract-text/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadFoldersGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Folders',
      operationId: 'getUploadFolders',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/folders');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UploadFoldersIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Get upload by ID',
      operationId: 'getUploadFolders_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/folders/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UploadFoldersIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for upload service. Security: role-based',
      summary: 'Update upload by ID',
      operationId: 'putUploadFolders',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/folders/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadMergeGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Merge',
      operationId: 'getUploadMerge',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/merge');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadMetadataFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Metadata',
      operationId: 'getUploadMetadata',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/metadata/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadMoveFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Move',
      operationId: 'getUploadMove',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/move/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadMultipleGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Multiple',
      operationId: 'getUploadMultiple',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/multiple');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadOcrFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Ocr',
      operationId: 'getUploadOcr',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/ocr/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadPoliciesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Policies',
      operationId: 'getUploadPolicies',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/policies');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadPreviewFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Preview',
      operationId: 'getUploadPreview',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/preview/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadProcessFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Process',
      operationId: 'getUploadProcess',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/process/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadRecentGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Recent',
      operationId: 'getUploadRecent',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/recent');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadRenameFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Rename',
      operationId: 'getUploadRename',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/rename/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadRestoreFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Restore',
      operationId: 'getUploadRestore',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/restore/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadResumeUploadIdGet({
    required String? uploadId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Resume',
      operationId: 'getUploadResume',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/resume/${uploadId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadScanFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Scan',
      operationId: 'getUploadScan',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/scan/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadShareFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Share',
      operationId: 'getUploadShare',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/share/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadSharedGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Shared',
      operationId: 'getUploadShared',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/shared');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadSignFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Sign',
      operationId: 'getUploadSign',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/sign/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadSingleGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Single',
      operationId: 'getUploadSingle',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/single');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadSplitFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Split',
      operationId: 'getUploadSplit',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/split/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadStatusUploadIdGet({
    required String? uploadId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Status',
      operationId: 'getUploadStatus',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/status/${uploadId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadStorageStatsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Storage Stats',
      operationId: 'getUploadStoragestats',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/storage-stats');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadTagsFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Tags',
      operationId: 'getUploadTags',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/tags/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadThumbnailFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Thumbnail',
      operationId: 'getUploadThumbnail',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/thumbnail/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadTrashGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Trash',
      operationId: 'getUploadTrash',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/trash');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadValidateGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Validate',
      operationId: 'getUploadValidate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/validate');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadVerifySignatureFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Verify Signature',
      operationId: 'getUploadVerifysignature',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/verify-signature/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UploadWatermarkFileIdGet({
    required String? fileId,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for upload service. Security: role-based',
      summary: 'Watermark',
      operationId: 'getUploadWatermark',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["upload"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/upload/watermark/${fileId}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'List users',
      operationId: 'getUsers',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'POST endpoint for users service. Security: user + admin',
      summary: 'Create users',
      operationId: 'postUsers',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsers_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsers',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1UsersIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'DELETE endpoint for users service. Security: user + admin',
      summary: 'Delete users by ID',
      operationId: 'deleteUsers',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersActivateIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersActivate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/activate/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersActivateIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersActivate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/activate/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersAnniversariesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Anniversaries',
      operationId: 'getUsersAnniversaries',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/anniversaries');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersAuditIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersAudit',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/audit/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersAuditIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersAudit',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/audit/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersAvatarGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Avatar',
      operationId: 'getUsersAvatar',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/avatar');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersAvatarIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersAvatar_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/avatar/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersAvatarIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersAvatar',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/avatar/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersBirthdaysGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Birthdays',
      operationId: 'getUsersBirthdays',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/birthdays');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersBulkGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Bulk',
      operationId: 'getUsersBulk',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/bulk');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersByDepartmentDeptGet({
    required String? dept,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'By Department',
      operationId: 'getUsersBydepartment',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/by-department/${dept}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersByRoleRoleGet({
    required String? role,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'By Role',
      operationId: 'getUsersByrole',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/by-role/${role}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersConsentGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Consent',
      operationId: 'getUsersConsent',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/consent');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersDataDeleteIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersDatadelete',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/data-delete/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersDataDeleteIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersDatadelete',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/data-delete/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersDataExportIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersDataexport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/data-export/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersDataExportIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersDataexport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/data-export/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersDeactivateIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersDeactivate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/deactivate/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersDeactivateIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersDeactivate',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/deactivate/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersDocumentsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Documents',
      operationId: 'getUsersDocuments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/documents');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersDocumentsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersDocuments_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/documents/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersDocumentsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersDocuments',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/documents/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersDuplicateCheckGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Duplicate Check',
      operationId: 'getUsersDuplicatecheck',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/duplicate-check');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersEmergencyContactsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Emergency Contacts',
      operationId: 'getUsersEmergencycontacts',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/emergency-contacts');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersEmergencyContactsIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersEmergencycontacts_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/emergency-contacts/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersEmergencyContactsIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersEmergencycontacts',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/emergency-contacts/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersExportGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Export',
      operationId: 'getUsersExport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/export');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersHistoryIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersHistory',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/history/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersHistoryIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersHistory',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/history/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersImportGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Import',
      operationId: 'getUsersImport',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/import');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersInsuranceGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Insurance',
      operationId: 'getUsersInsurance',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/insurance');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersInsuranceIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersInsurance_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/insurance/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersInsuranceIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersInsurance',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/insurance/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersMedicalInfoGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Medical Info',
      operationId: 'getUsersMedicalinfo',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/medical-info');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersMedicalInfoIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersMedicalinfo_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/medical-info/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersMedicalInfoIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersMedicalinfo',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/medical-info/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersMergeGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Merge',
      operationId: 'getUsersMerge',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/merge');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersNotificationsPreferencesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Preferences',
      operationId: 'getUsersNotificationsPreferences',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/notifications/preferences');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersNotificationsSettingsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Settings',
      operationId: 'getUsersNotificationsSettings',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/notifications/settings');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersOnlineGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Online',
      operationId: 'getUsersOnline',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/online');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersPasswordChangeGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Change',
      operationId: 'getUsersPasswordChange',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/password/change');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersPasswordResetGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Reset',
      operationId: 'getUsersPasswordReset',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/password/reset');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersPreferencesGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Preferences',
      operationId: 'getUsersPreferences',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/preferences');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersPreferencesIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersPreferences_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/preferences/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersPreferencesIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersPreferences',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/preferences/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersPrivacySettingsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Privacy Settings',
      operationId: 'getUsersPrivacysettings',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/privacy-settings');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersProfileGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Profile',
      operationId: 'getUsersProfile',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/profile');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersProfileIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Get users by ID',
      operationId: 'getUsersProfile_2',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/profile/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1UsersProfileIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for users service. Security: user + admin',
      summary: 'Update users by ID',
      operationId: 'putUsersProfile',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/profile/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersRecentGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Recent',
      operationId: 'getUsersRecent',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/recent');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersSearchGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Search',
      operationId: 'getUsersSearch',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/search');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersSessionsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Sessions',
      operationId: 'getUsersSessions',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/sessions');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersStatisticsGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Statistics',
      operationId: 'getUsersStatistics',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/statistics');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersTwoFactorGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Two Factor',
      operationId: 'getUsersTwofactor',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/two-factor');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersVerifyEmailGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Verify Email',
      operationId: 'getUsersVerifyemail',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/verify-email');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1UsersVerifyPhoneGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for users service. Security: user + admin',
      summary: 'Verify Phone',
      operationId: 'getUsersVerifyphone',
      consumes: [],
      produces: [],
      security: ["ApiKeyAuth", "BearerAuth"],
      tags: ["users"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/users/verify-phone');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1VersionGet({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for version service. Security: public + admin',
      summary: 'List version',
      operationId: 'getVersion',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<Success>> _apiV1VersionPost({
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'POST endpoint for version service. Security: public + admin',
      summary: 'Create version',
      operationId: 'postVersion',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version');
    final $body = body;
    final Request $request = Request(
      'POST',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1VersionIdGet({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for version service. Security: public + admin',
      summary: 'Get version by ID',
      operationId: 'getVersion_2',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version/${id}');
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<Success>> _apiV1VersionIdPut({
    required String? id,
    required Object? body,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'PUT endpoint for version service. Security: public + admin',
      summary: 'Update version by ID',
      operationId: 'putVersion',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version/${id}');
    final $body = body;
    final Request $request = Request(
      'PUT',
      $url,
      client.baseUrl,
      body: $body,
      tag: swaggerMetaData,
    );
    return client.send<Success, Success>($request);
  }

  @override
  Future<Response<dynamic>> _apiV1VersionIdDelete({
    required String? id,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description:
          'DELETE endpoint for version service. Security: public + admin',
      summary: 'Delete version by ID',
      operationId: 'deleteVersion',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version/${id}');
    final Request $request = Request(
      'DELETE',
      $url,
      client.baseUrl,
      tag: swaggerMetaData,
    );
    return client.send<dynamic, dynamic>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1VersionEndpoint5Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for version service. Security: public + admin',
      summary: 'Endpoint5',
      operationId: 'getVersionEndpoint5',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version/endpoint5');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1VersionEndpoint6Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for version service. Security: public + admin',
      summary: 'Endpoint6',
      operationId: 'getVersionEndpoint6',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version/endpoint6');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1VersionEndpoint7Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for version service. Security: public + admin',
      summary: 'Endpoint7',
      operationId: 'getVersionEndpoint7',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version/endpoint7');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1VersionEndpoint8Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for version service. Security: public + admin',
      summary: 'Endpoint8',
      operationId: 'getVersionEndpoint8',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version/endpoint8');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }

  @override
  Future<Response<PaginatedResponse>> _apiV1VersionEndpoint9Get({
    int? page,
    int? limit,
    String? search,
    String? sort,
    String? order,
    SwaggerMetaData swaggerMetaData = const SwaggerMetaData(
      description: 'GET endpoint for version service. Security: public + admin',
      summary: 'Endpoint9',
      operationId: 'getVersionEndpoint9',
      consumes: [],
      produces: [],
      security: [],
      tags: ["version"],
      deprecated: false,
    ),
  }) {
    final Uri $url = Uri.parse('/api/v1/version/endpoint9');
    final Map<String, dynamic> $params = <String, dynamic>{
      'page': page,
      'limit': limit,
      'search': search,
      'sort': sort,
      'order': order,
    };
    final Request $request = Request(
      'GET',
      $url,
      client.baseUrl,
      parameters: $params,
      tag: swaggerMetaData,
    );
    return client.send<PaginatedResponse, PaginatedResponse>($request);
  }
}
