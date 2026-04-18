--
-- PostgreSQL database dump
--

-- Dumped from database version 15.13 (Debian 15.13-1.pgdg120+1)
-- Dumped by pg_dump version 15.13 (Debian 15.13-1.pgdg120+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


--
-- Name: generate_grievance_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_grievance_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.grievance_number := 'GRV-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('grievance_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$;


--
-- Name: generate_hk_log_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_hk_log_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.log_number := 'HK-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('hk_log_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$;


--
-- Name: generate_hk_req_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_hk_req_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.request_number := 'HKR-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('hk_req_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$;


--
-- Name: generate_incident_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_incident_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.report_number := 'INC-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('incident_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$;


--
-- Name: generate_inv_booking_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_inv_booking_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(booking_number FROM 10) AS INTEGER)), 0) + 1
  INTO next_num
  FROM investigation_bookings
  WHERE booking_number LIKE 'INV-' || EXTRACT(YEAR FROM NOW()) || '-%';

  NEW.booking_number := 'INV-' || EXTRACT(YEAR FROM NOW()) || '-' || LPAD(next_num::TEXT, 4, '0');
  NEW.sla_confirm_target := NEW.created_at + INTERVAL '30 minutes';
  RETURN NEW;
END;
$$;


--
-- Name: generate_pharmacy_order_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_pharmacy_order_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(order_number FROM 10) AS INTEGER)), 0) + 1
  INTO next_num
  FROM pharmacy_orders
  WHERE order_number LIKE 'PHR-' || EXTRACT(YEAR FROM NOW()) || '-%';
  
  NEW.order_number := 'PHR-' || EXTRACT(YEAR FROM NOW()) || '-' || LPAD(next_num::TEXT, 4, '0');
  NEW.sla_confirm_target := COALESCE(NEW.created_at, NOW()) + INTERVAL '15 minutes';
  RETURN NEW;
END;
$$;


--
-- Name: generate_revision_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_revision_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.revision_number := 'REV-' || TO_CHAR(NOW(), 'YYYY') || '-' || LPAD(nextval('revision_number_seq')::TEXT, 4, '0');
  RETURN NEW;
END;
$$;


--
-- Name: generate_rx_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_rx_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  next_num INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(prescription_number FROM 9) AS INTEGER)), 0) + 1
  INTO next_num
  FROM e_prescriptions
  WHERE prescription_number LIKE 'RX-' || EXTRACT(YEAR FROM NOW()) || '-%';
  
  NEW.prescription_number := 'RX-' || EXTRACT(YEAR FROM NOW()) || '-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$;


--
-- Name: _migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public._migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: abdm_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.abdm_consents (
    id integer NOT NULL,
    consent_id character varying(100),
    patient_uid uuid NOT NULL,
    hip_id character varying(100),
    hiu_id character varying(100),
    purpose character varying(100),
    hi_types text[],
    date_range_from date,
    date_range_to date,
    expiry_date date,
    status character varying(50) DEFAULT 'REQUESTED'::character varying,
    requester_name character varying(255),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: abdm_consents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.abdm_consents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: abdm_consents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.abdm_consents_id_seq OWNED BY public.abdm_consents.id;


--
-- Name: abdm_data_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.abdm_data_requests (
    id integer NOT NULL,
    transaction_id character varying(100),
    consent_id character varying(100),
    patient_uid uuid,
    hi_types text[],
    date_range_from date,
    date_range_to date,
    key_material jsonb,
    status character varying(50) DEFAULT 'PROCESSING'::character varying,
    delivered_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: abdm_data_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.abdm_data_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: abdm_data_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.abdm_data_requests_id_seq OWNED BY public.abdm_data_requests.id;


--
-- Name: admin_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_actions (
    id integer NOT NULL,
    admin_uid uuid,
    action_type character varying(100) NOT NULL,
    target_type character varying(100),
    target_id character varying(100),
    reason text,
    details jsonb,
    ip_address character varying(45),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: admin_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_actions_id_seq OWNED BY public.admin_actions.id;


--
-- Name: admin_activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_activity_logs (
    id integer NOT NULL,
    admin_uid uuid,
    action character varying(100) NOT NULL,
    description text,
    details jsonb,
    affected_user_id uuid,
    ip_address character varying(45),
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: admin_activity_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_activity_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_activity_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_activity_logs_id_seq OWNED BY public.admin_activity_logs.id;


--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    uid uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    email character varying(255),
    name character varying(255),
    role character varying(50) DEFAULT 'ADMIN'::character varying,
    permissions text[],
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_login timestamp(6) without time zone,
    created_by uuid,
    deactivated_by uuid,
    deactivation_reason text,
    deactivated_at timestamp(6) without time zone,
    reactivated_by uuid,
    reactivated_at timestamp(6) without time zone,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    last_failed_login timestamp without time zone,
    totp_enabled boolean DEFAULT false NOT NULL,
    password_changed_at timestamp without time zone,
    updated_at timestamp without time zone
);


--
-- Name: admissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admissions (
    id integer NOT NULL,
    encounter_id character varying(50),
    patient_uid uuid NOT NULL,
    admitting_doctor uuid,
    attending_doctor uuid,
    department character varying(100),
    ward character varying(100),
    bed_id integer,
    bed_number character varying(20),
    chief_complaint text,
    admitting_diagnosis text,
    discharge_diagnosis text,
    admission_type character varying(50) DEFAULT 'elective'::character varying,
    status character varying(50) DEFAULT 'admitted'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'routine'::character varying,
    code_status character varying(50) DEFAULT 'full_code'::character varying,
    insurance_info jsonb,
    emergency_contact jsonb,
    allergies text[],
    expected_los_days integer,
    discharge_type character varying(50),
    discharge_summary text,
    discharge_notes text,
    reason text,
    admitted_at timestamp without time zone DEFAULT now(),
    discharged_at timestamp without time zone,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: admissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admissions_id_seq OWNED BY public.admissions.id;


--
-- Name: advance_deductions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.advance_deductions (
    id integer NOT NULL,
    advance_id integer,
    payslip_id integer,
    staff_uid uuid,
    month integer,
    year integer,
    amount_deducted numeric(10,2),
    balance_after numeric(12,2),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: advance_deductions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.advance_deductions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: advance_deductions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.advance_deductions_id_seq OWNED BY public.advance_deductions.id;


--
-- Name: allergies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allergies (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    allergen character varying(255) NOT NULL,
    name character varying(255),
    allergy_type character varying(50) DEFAULT 'medication'::character varying,
    severity character varying(20),
    reaction text,
    status character varying(20) DEFAULT 'active'::character varying,
    recorded_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: allergies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.allergies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: allergies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.allergies_id_seq OWNED BY public.allergies.id;


--
-- Name: annual_review_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.annual_review_reminders (
    id integer NOT NULL,
    staff_uid uuid,
    review_year integer NOT NULL,
    reminder_sent_at timestamp without time zone,
    revision_id integer,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: annual_review_reminders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.annual_review_reminders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: annual_review_reminders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.annual_review_reminders_id_seq OWNED BY public.annual_review_reminders.id;


--
-- Name: annual_tax_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.annual_tax_summaries (
    id integer NOT NULL,
    staff_uid uuid,
    financial_year character varying(10) NOT NULL,
    total_basic numeric(14,2) DEFAULT 0,
    total_hra numeric(14,2) DEFAULT 0,
    total_da numeric(14,2) DEFAULT 0,
    total_special_allowance numeric(14,2) DEFAULT 0,
    total_transport_allowance numeric(14,2) DEFAULT 0,
    total_medical_allowance numeric(14,2) DEFAULT 0,
    total_overtime numeric(14,2) DEFAULT 0,
    total_bonus numeric(14,2) DEFAULT 0,
    total_arrears numeric(14,2) DEFAULT 0,
    total_gross numeric(14,2) DEFAULT 0,
    total_pf numeric(14,2) DEFAULT 0,
    total_esi numeric(14,2) DEFAULT 0,
    total_professional_tax numeric(14,2) DEFAULT 0,
    total_tds numeric(14,2) DEFAULT 0,
    total_advance_deductions numeric(14,2) DEFAULT 0,
    total_deductions numeric(14,2) DEFAULT 0,
    total_net numeric(14,2) DEFAULT 0,
    taxable_income numeric(14,2) DEFAULT 0,
    tax_payable numeric(14,2) DEFAULT 0,
    months_included integer DEFAULT 0,
    generated_at timestamp without time zone,
    pdf_key text,
    status character varying(20) DEFAULT 'draft'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: annual_tax_summaries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.annual_tax_summaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: annual_tax_summaries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.annual_tax_summaries_id_seq OWNED BY public.annual_tax_summaries.id;


--
-- Name: anomalies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anomalies (
    id integer NOT NULL,
    staff_id integer,
    staff_name character varying(255),
    department character varying(100),
    late_days integer DEFAULT 0,
    early_leave_days integer DEFAULT 0,
    absent_days integer DEFAULT 0,
    period_start date,
    period_end date,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: anomalies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.anomalies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: anomalies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.anomalies_id_seq OWNED BY public.anomalies.id;


--
-- Name: api_access_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_access_logs (
    id integer NOT NULL,
    endpoint text NOT NULL,
    method character varying(10),
    user_id uuid,
    ip_address character varying(45),
    status_code integer,
    response_ms integer,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: api_access_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_access_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_access_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_access_logs_id_seq OWNED BY public.api_access_logs.id;


--
-- Name: appointment_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointment_archive (
    id integer NOT NULL,
    original_id integer,
    patient_id integer,
    doctor_id integer,
    appointment_date date,
    status character varying(50),
    reason text,
    notes text,
    deleted_by uuid,
    deleted_at timestamp without time zone DEFAULT now(),
    deletion_reason text
);


--
-- Name: appointment_archive_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.appointment_archive_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: appointment_archive_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.appointment_archive_id_seq OWNED BY public.appointment_archive.id;


--
-- Name: appointment_daily_token_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.appointment_daily_token_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: appointment_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointment_documents (
    id integer NOT NULL,
    appointment_id integer,
    patient_id integer,
    doctor_id integer,
    uploaded_by integer,
    upload_role character varying(20) DEFAULT 'staff'::character varying NOT NULL,
    document_type character varying(30) DEFAULT 'prescription'::character varying NOT NULL,
    file_key text NOT NULL,
    file_url text,
    file_name character varying(500),
    file_size integer,
    file_mime character varying(100),
    notes text,
    is_visible_to_patient boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: appointment_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.appointment_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: appointment_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.appointment_documents_id_seq OWNED BY public.appointment_documents.id;


--
-- Name: appointment_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointment_status_history (
    id integer NOT NULL,
    appointment_id integer,
    from_status character varying(50),
    to_status character varying(50) NOT NULL,
    changed_by integer,
    changed_by_role character varying(50),
    reason text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: appointment_status_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.appointment_status_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: appointment_status_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.appointment_status_history_id_seq OWNED BY public.appointment_status_history.id;


--
-- Name: appointments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appointments (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    doctor_id integer,
    doctor_name character varying(100) DEFAULT ''::character varying NOT NULL,
    patient_name character varying(255),
    appointment_date date NOT NULL,
    appointment_time character varying(10) NOT NULL,
    status character varying(50) DEFAULT 'SCHEDULED'::character varying NOT NULL,
    reason text,
    notes text,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    token_number integer,
    confirmed_by integer,
    confirmed_at timestamp without time zone,
    confirmation_notes text,
    no_show_at timestamp without time zone,
    cancellation_reason text,
    reschedule_count integer DEFAULT 0,
    sla_target_at timestamp without time zone,
    first_contact_at timestamp without time zone,
    completed_at timestamp without time zone,
    department character varying(255),
    reminder_24h_sent boolean DEFAULT false,
    reminder_1h_sent boolean DEFAULT false,
    patient_id integer
);


--
-- Name: appointments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.appointments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: appointments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.appointments_id_seq OWNED BY public.appointments.id;


--
-- Name: attendance_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_disputes (
    id integer NOT NULL,
    staff_id integer,
    date date NOT NULL,
    dispute_type character varying(50) NOT NULL,
    description text NOT NULL,
    requested_check_in timestamp without time zone,
    requested_check_out timestamp without time zone,
    evidence_url text,
    status character varying(20) DEFAULT 'pending'::character varying,
    reviewed_by integer,
    reviewed_at timestamp without time zone,
    reviewer_comment text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: attendance_disputes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attendance_disputes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attendance_disputes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attendance_disputes_id_seq OWNED BY public.attendance_disputes.id;


--
-- Name: attendance_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_logs (
    id integer NOT NULL,
    staff_id integer,
    action character varying(50) NOT NULL,
    marked_by uuid,
    location character varying(255),
    hours_worked double precision,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: attendance_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attendance_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attendance_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attendance_logs_id_seq OWNED BY public.attendance_logs.id;


--
-- Name: attendance_regularization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_regularization (
    id integer NOT NULL,
    staff_id integer,
    date date NOT NULL,
    reason text NOT NULL,
    requested_check_in timestamp without time zone,
    requested_check_out timestamp without time zone,
    status character varying(20) DEFAULT 'pending'::character varying,
    reviewed_by integer,
    reviewed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: attendance_regularization_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attendance_regularization_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attendance_regularization_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attendance_regularization_id_seq OWNED BY public.attendance_regularization.id;


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    user_id integer,
    user_name character varying(200),
    user_role character varying(100),
    ip_address character varying(50),
    method character varying(10) NOT NULL,
    path text NOT NULL,
    module character varying(50),
    action character varying(100),
    query_params jsonb,
    request_summary text,
    status_code integer,
    response_time_ms integer,
    success boolean,
    error_message text,
    user_agent text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id integer NOT NULL,
    uid uuid,
    role character varying(50),
    action character varying(100) NOT NULL,
    resource character varying(100),
    resource_id character varying(100),
    metadata jsonb,
    ip_address character varying(45),
    user_agent text,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: auth_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_logs (
    id integer NOT NULL,
    phone character varying(15),
    user_id uuid,
    action character varying(100) NOT NULL,
    success boolean NOT NULL,
    failure_reason text,
    auth_method character varying(50),
    ip_address character varying(45),
    user_agent text,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: auth_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_logs_id_seq OWNED BY public.auth_logs.id;


--
-- Name: batch_upload_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.batch_upload_logs (
    id integer NOT NULL,
    batch_id character varying(100) NOT NULL,
    uploaded_by uuid,
    total_files integer,
    successful_files integer,
    failed_files integer,
    total_processing_time_ms integer,
    category character varying(100),
    is_hipaa_protected boolean,
    completed_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: batch_upload_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.batch_upload_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: batch_upload_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.batch_upload_logs_id_seq OWNED BY public.batch_upload_logs.id;


--
-- Name: bed_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bed_transfers (
    id integer NOT NULL,
    patient_uid uuid,
    admission_id integer,
    from_bed_id integer,
    to_bed_id integer,
    reason text,
    transferred_by uuid,
    transferred_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: bed_transfers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bed_transfers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bed_transfers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bed_transfers_id_seq OWNED BY public.bed_transfers.id;


--
-- Name: beds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.beds (
    id integer NOT NULL,
    ward_id integer,
    ward_name character varying(100),
    bed_number character varying(20) NOT NULL,
    bed_type character varying(50) DEFAULT 'general'::character varying,
    floor character varying(20),
    status character varying(20) DEFAULT 'available'::character varying NOT NULL,
    patient_uid uuid,
    patient_id integer,
    patient_name character varying(255),
    admission_id integer,
    admitted_at timestamp without time zone,
    expected_discharge timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    assigned_at timestamp without time zone
);


--
-- Name: beds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.beds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: beds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.beds_id_seq OWNED BY public.beds.id;


--
-- Name: blood_banks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blood_banks (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    address text,
    latitude double precision,
    longitude double precision,
    phone character varying(15),
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: blood_banks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.blood_banks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: blood_banks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.blood_banks_id_seq OWNED BY public.blood_banks.id;


--
-- Name: blood_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blood_requests (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    blood_group character varying(5) NOT NULL,
    component character varying(50) NOT NULL,
    units integer NOT NULL,
    urgency character varying(20) DEFAULT 'routine'::character varying,
    clinical_indication text NOT NULL,
    cross_match_status character varying(20) DEFAULT 'pending'::character varying,
    status character varying(50) DEFAULT 'requested'::character varying,
    ordered_by uuid NOT NULL,
    cross_matched_by uuid,
    cross_matched_at timestamp without time zone,
    issued_by uuid,
    issued_at timestamp without time zone,
    transfused_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: blood_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.blood_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: blood_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.blood_requests_id_seq OWNED BY public.blood_requests.id;


--
-- Name: bulk_operation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_operation_logs (
    id integer NOT NULL,
    operation_type character varying(100) NOT NULL,
    performed_by uuid,
    total_items integer,
    affected_count integer,
    success_count integer,
    error_count integer,
    operation_details jsonb,
    performed_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: bulk_operation_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bulk_operation_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bulk_operation_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bulk_operation_logs_id_seq OWNED BY public.bulk_operation_logs.id;


--
-- Name: bulk_revision_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_revision_jobs (
    id integer NOT NULL,
    description text NOT NULL,
    revision_type character varying(20) NOT NULL,
    target_type character varying(20) NOT NULL,
    target_value character varying(100),
    increment_type character varying(10),
    increment_value numeric(10,2),
    bonus_amount numeric(10,2),
    effective_from date NOT NULL,
    staff_count integer DEFAULT 0,
    processed_count integer DEFAULT 0,
    status character varying(20) DEFAULT 'draft'::character varying,
    approved_by uuid,
    approved_at timestamp without time zone,
    completed_at timestamp without time zone,
    error_log text,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: bulk_revision_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bulk_revision_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bulk_revision_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bulk_revision_jobs_id_seq OWNED BY public.bulk_revision_jobs.id;


--
-- Name: canary_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canary_checks (
    id integer NOT NULL,
    checked_at timestamp without time zone DEFAULT now() NOT NULL,
    status character varying(20) DEFAULT 'ok'::character varying NOT NULL,
    details jsonb
);


--
-- Name: canary_checks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.canary_checks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: canary_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.canary_checks_id_seq OWNED BY public.canary_checks.id;


--
-- Name: cds_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cds_alerts (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    alert_type character varying(100) NOT NULL,
    severity character varying(20) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    source_data jsonb,
    acknowledged boolean DEFAULT false,
    ack_by uuid,
    ack_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: cds_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cds_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cds_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cds_alerts_id_seq OWNED BY public.cds_alerts.id;


--
-- Name: clinical_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinical_alerts (
    id integer NOT NULL,
    patient_id integer,
    alert_type character varying(50) DEFAULT 'VITAL_ANOMALY'::character varying NOT NULL,
    vital_name character varying(100),
    vital_value numeric(10,4),
    severity character varying(20) DEFAULT 'medium'::character varying NOT NULL,
    message text,
    acknowledged boolean DEFAULT false NOT NULL,
    acknowledged_by integer,
    acknowledged_at timestamp without time zone,
    created_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: clinical_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clinical_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clinical_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clinical_alerts_id_seq OWNED BY public.clinical_alerts.id;


--
-- Name: clinical_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinical_notes (
    id integer NOT NULL,
    encounter_id character varying(50),
    patient_uid uuid NOT NULL,
    author_uid uuid NOT NULL,
    author_role character varying(100),
    note_type character varying(50) NOT NULL,
    content jsonb NOT NULL,
    version integer DEFAULT 1,
    parent_note_id integer,
    is_addendum boolean DEFAULT false,
    is_signed boolean DEFAULT false,
    signed_at timestamp without time zone,
    signed_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: clinical_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clinical_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clinical_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clinical_notes_id_seq OWNED BY public.clinical_notes.id;


--
-- Name: clinical_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinical_orders (
    id integer NOT NULL,
    order_number character varying(30),
    encounter_id character varying(50),
    patient_uid uuid NOT NULL,
    order_type character varying(50) NOT NULL,
    priority character varying(20) DEFAULT 'routine'::character varying,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(50) DEFAULT 'ordered'::character varying,
    ordered_by uuid,
    verified_by uuid,
    start_date date,
    end_date date,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: clinical_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clinical_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clinical_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clinical_orders_id_seq OWNED BY public.clinical_orders.id;


--
-- Name: clinical_protocols; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clinical_protocols (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    category character varying(100),
    description text,
    steps jsonb,
    is_active boolean DEFAULT true,
    version character varying(20),
    created_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: clinical_protocols_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clinical_protocols_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clinical_protocols_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clinical_protocols_id_seq OWNED BY public.clinical_protocols.id;


--
-- Name: consultations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consultations (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    doctor_id integer,
    consultation_notes text,
    diagnosis text,
    treatment_plan text,
    file_name character varying(255),
    file_type character varying(50),
    file_key text,
    consulted_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: consultations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.consultations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: consultations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.consultations_id_seq OWNED BY public.consultations.id;


--
-- Name: data_breaches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_breaches (
    id integer NOT NULL,
    breach_id character varying(30),
    severity character varying(20) NOT NULL,
    description text NOT NULL,
    affected_records integer DEFAULT 0,
    affected_patient_uids uuid[],
    discovered_at timestamp without time zone DEFAULT now(),
    reported_by uuid,
    status character varying(50) DEFAULT 'open'::character varying,
    resolution_notes text,
    resolved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: data_breaches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.data_breaches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: data_breaches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.data_breaches_id_seq OWNED BY public.data_breaches.id;


--
-- Name: delivery_location_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_location_updates (
    id integer NOT NULL,
    order_type character varying(20) NOT NULL,
    order_id integer NOT NULL,
    delivery_person_id integer,
    lat numeric(10,7) NOT NULL,
    lng numeric(10,7) NOT NULL,
    accuracy numeric(6,2),
    speed numeric(6,2),
    heading numeric(6,2),
    battery_level integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: delivery_location_updates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.delivery_location_updates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: delivery_location_updates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.delivery_location_updates_id_seq OWNED BY public.delivery_location_updates.id;


--
-- Name: department_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.department_audit_log (
    id integer NOT NULL,
    department_id integer,
    user_id uuid,
    action character varying(100) NOT NULL,
    old_data jsonb,
    new_data jsonb,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: department_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.department_audit_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: department_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.department_audit_log_id_seq OWNED BY public.department_audit_log.id;


--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: departments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.departments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: departments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.departments_id_seq OWNED BY public.departments.id;


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    device_id character varying(255) NOT NULL,
    fcm_token text,
    device_name character varying(255),
    platform character varying(50),
    app_version character varying(50),
    os_version character varying(50),
    is_active boolean DEFAULT true NOT NULL,
    last_used timestamp(6) without time zone,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: devices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.devices_id_seq OWNED BY public.devices.id;


--
-- Name: diagnoses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diagnoses (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    icd10_code character varying(20),
    icd10_description text,
    description text NOT NULL,
    diagnosis_type character varying(50) DEFAULT 'primary'::character varying,
    status character varying(50) DEFAULT 'active'::character varying,
    onset_date date,
    resolved_date date,
    severity character varying(20),
    diagnosed_by uuid,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: diagnoses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.diagnoses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: diagnoses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.diagnoses_id_seq OWNED BY public.diagnoses.id;


--
-- Name: diet_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.diet_orders (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    diet_type character varying(50) NOT NULL,
    restrictions text[],
    allergies text[],
    meal_preferences text,
    calories_target integer,
    special_instructions text,
    status character varying(20) DEFAULT 'active'::character varying,
    ordered_by uuid NOT NULL,
    reviewed_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: diet_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.diet_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: diet_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.diet_orders_id_seq OWNED BY public.diet_orders.id;


--
-- Name: discharge_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discharge_summaries (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    admission_id integer,
    attending_doctor uuid,
    summary_text text,
    discharge_date date,
    follow_up text,
    medications jsonb,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: discharge_summaries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discharge_summaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discharge_summaries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discharge_summaries_id_seq OWNED BY public.discharge_summaries.id;


--
-- Name: doctors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctors (
    id integer NOT NULL,
    user_id integer,
    name character varying(100) DEFAULT ''::character varying NOT NULL,
    department_id integer,
    department character varying(100) NOT NULL,
    specialty character varying(100),
    intro text,
    image_url text,
    is_available boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: doctors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.doctors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: doctors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.doctors_id_seq OWNED BY public.doctors.id;


--
-- Name: drug_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drug_interactions (
    id integer NOT NULL,
    drug_a character varying(255) NOT NULL,
    drug_b character varying(255) NOT NULL,
    severity character varying(20) NOT NULL,
    description text,
    clinical_effect text,
    management text,
    source character varying(100),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: drug_interactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drug_interactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drug_interactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drug_interactions_id_seq OWNED BY public.drug_interactions.id;


--
-- Name: e_prescriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.e_prescriptions (
    id integer NOT NULL,
    prescription_number character varying(30),
    appointment_id integer,
    patient_id integer,
    doctor_id integer,
    diagnosis text,
    clinical_notes text,
    medications jsonb DEFAULT '[]'::jsonb NOT NULL,
    follow_up_date date,
    follow_up_notes text,
    vitals jsonb,
    handwritten_photo_key text,
    pdf_key text,
    pharmacy_order_id integer,
    pharmacy_opted boolean DEFAULT false,
    pharmacy_opt_type character varying(20),
    status character varying(20) DEFAULT 'created'::character varying,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: e_prescriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.e_prescriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: e_prescriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.e_prescriptions_id_seq OWNED BY public.e_prescriptions.id;


--
-- Name: emergency_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emergency_services (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    phone character varying(20),
    type character varying(50) DEFAULT 'hospital'::character varying,
    address text,
    latitude double precision,
    longitude double precision,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: emergency_services_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.emergency_services_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: emergency_services_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.emergency_services_id_seq OWNED BY public.emergency_services.id;


--
-- Name: failed_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.failed_notifications (
    id integer NOT NULL,
    user_id uuid,
    type character varying(20) DEFAULT 'push'::character varying NOT NULL,
    phone character varying(20),
    device_token text,
    title character varying(255),
    body text,
    data jsonb,
    error_message text,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 4,
    last_retry_at timestamp without time zone,
    next_retry_at timestamp without time zone,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: failed_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.failed_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: failed_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.failed_notifications_id_seq OWNED BY public.failed_notifications.id;


--
-- Name: feature_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flags (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    is_enabled boolean DEFAULT false,
    enabled boolean DEFAULT false,
    rollout_percentage integer DEFAULT 0,
    allowed_roles text[],
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: feature_flags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feature_flags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feature_flags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feature_flags_id_seq OWNED BY public.feature_flags.id;


--
-- Name: feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    rating smallint NOT NULL,
    comment text,
    category character varying(50) DEFAULT 'GENERAL'::character varying,
    department_id integer,
    doctor_id integer,
    appointment_id integer,
    is_anonymous boolean DEFAULT false NOT NULL,
    status character varying(50) DEFAULT 'PENDING'::character varying NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    responded_at timestamp without time zone,
    response_status character varying(50)
);


--
-- Name: feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feedback_id_seq OWNED BY public.feedback.id;


--
-- Name: feedback_responses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback_responses (
    id integer NOT NULL,
    feedback_id integer,
    responder_uid uuid,
    response_text text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: feedback_responses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feedback_responses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feedback_responses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feedback_responses_id_seq OWNED BY public.feedback_responses.id;


--
-- Name: file_access_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_access_logs (
    id integer NOT NULL,
    file_id integer,
    user_id uuid,
    access_type character varying(50) NOT NULL,
    ip_address character varying(45),
    user_agent text,
    accessed_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes text
);


--
-- Name: file_access_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.file_access_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: file_access_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.file_access_logs_id_seq OWNED BY public.file_access_logs.id;


--
-- Name: file_deletion_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_deletion_log (
    id integer NOT NULL,
    file_id integer,
    file_name character varying(255),
    storage_key text,
    category character varying(100),
    file_size bigint,
    is_hipaa_protected boolean,
    uploaded_by uuid,
    deleted_by uuid,
    deletion_reason text,
    deletion_type character varying(50),
    deleted_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip_address character varying(45)
);


--
-- Name: file_deletion_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.file_deletion_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: file_deletion_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.file_deletion_log_id_seq OWNED BY public.file_deletion_log.id;


--
-- Name: file_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_metadata (
    id integer NOT NULL,
    file_name character varying(255) NOT NULL,
    file_type character varying(100) NOT NULL,
    storage_key text NOT NULL,
    storage_url text NOT NULL,
    file_size bigint NOT NULL,
    uploaded_by uuid,
    scan_status character varying(50) DEFAULT 'PENDING'::character varying,
    scan_result text,
    privacy_level character varying(20) DEFAULT 'RESTRICTED'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    uploaded_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: file_metadata_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.file_metadata_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: file_metadata_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.file_metadata_id_seq OWNED BY public.file_metadata.id;


--
-- Name: full_final_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.full_final_settlements (
    id integer NOT NULL,
    staff_uid uuid,
    separation_type character varying(30) NOT NULL,
    last_working_day date NOT NULL,
    last_month_days_worked integer,
    last_month_basic numeric(12,2) DEFAULT 0,
    last_month_allowances numeric(12,2) DEFAULT 0,
    earned_leave_balance integer DEFAULT 0,
    leave_encashment_amount numeric(12,2) DEFAULT 0,
    notice_period_days integer DEFAULT 0,
    notice_shortfall_days integer DEFAULT 0,
    notice_recovery_amount numeric(12,2) DEFAULT 0,
    years_of_service numeric(5,2) DEFAULT 0,
    gratuity_eligible boolean DEFAULT false,
    gratuity_amount numeric(12,2) DEFAULT 0,
    bonus_payable numeric(12,2) DEFAULT 0,
    other_deductions numeric(12,2) DEFAULT 0,
    other_deductions_reason text,
    gross_payable numeric(12,2) DEFAULT 0,
    total_deductions numeric(12,2) DEFAULT 0,
    net_payable numeric(12,2) DEFAULT 0,
    status character varying(20) DEFAULT 'draft'::character varying,
    hr_approved_by uuid,
    hr_approved_at timestamp without time zone,
    admin_approved_by uuid,
    admin_approved_at timestamp without time zone,
    payment_date date,
    payment_reference text,
    notes text,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: full_final_settlements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.full_final_settlements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: full_final_settlements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.full_final_settlements_id_seq OWNED BY public.full_final_settlements.id;


--
-- Name: gdpr_erasure_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gdpr_erasure_log (
    id integer NOT NULL,
    uid uuid,
    phone_hash character varying(255),
    requested_by uuid,
    reason text,
    ip character varying(45),
    tables_processed text[],
    completed_at timestamp without time zone,
    duration_ms integer,
    results jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: gdpr_erasure_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gdpr_erasure_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gdpr_erasure_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gdpr_erasure_log_id_seq OWNED BY public.gdpr_erasure_log.id;


--
-- Name: geofence_breaches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geofence_breaches (
    id integer NOT NULL,
    staff_id integer,
    action character varying(20) NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7),
    distance_meters integer,
    occurred_at timestamp without time zone DEFAULT now(),
    alerted boolean DEFAULT false
);


--
-- Name: geofence_breaches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.geofence_breaches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: geofence_breaches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.geofence_breaches_id_seq OWNED BY public.geofence_breaches.id;


--
-- Name: grievance_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grievance_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: health_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.health_records (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    record_type character varying(50) DEFAULT 'GENERAL'::character varying,
    file_name character varying(255) NOT NULL,
    file_type character varying(50) NOT NULL,
    file_key text,
    file_size bigint,
    privacy_level character varying(20) DEFAULT 'RESTRICTED'::character varying NOT NULL,
    created_by uuid,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: health_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.health_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: health_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.health_records_id_seq OWNED BY public.health_records.id;


--
-- Name: hipaa_access_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hipaa_access_log (
    id bigint NOT NULL,
    accessed_by uuid,
    accessed_by_role character varying(100),
    patient_id uuid,
    record_type character varying(100),
    action character varying(100),
    ip_address character varying(45),
    request_id character varying(100),
    accessed_at timestamp without time zone DEFAULT now()
);


--
-- Name: hipaa_access_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hipaa_access_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hipaa_access_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hipaa_access_log_id_seq OWNED BY public.hipaa_access_log.id;


--
-- Name: hk_log_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hk_log_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hk_req_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hk_req_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hospitals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hospitals (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    address text,
    latitude double precision,
    longitude double precision,
    phone character varying(15),
    emergency_services boolean DEFAULT false NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: hospitals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hospitals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hospitals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hospitals_id_seq OWNED BY public.hospitals.id;


--
-- Name: housekeeping_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.housekeeping_logs (
    id integer NOT NULL,
    log_number character varying(30) NOT NULL,
    staff_id integer,
    zone_id integer,
    location_text character varying(300),
    latitude numeric(10,7),
    longitude numeric(10,7),
    cleaning_type character varying(50) DEFAULT 'routine'::character varying,
    notes text,
    photo_key text,
    photo_url text,
    signature_hash character varying(64),
    status character varying(20) DEFAULT 'submitted'::character varying,
    verified_by integer,
    verified_at timestamp without time zone,
    flag_reason text,
    logged_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: housekeeping_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.housekeeping_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: housekeeping_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.housekeeping_logs_id_seq OWNED BY public.housekeeping_logs.id;


--
-- Name: housekeeping_request_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.housekeeping_request_updates (
    id integer NOT NULL,
    request_id integer,
    author_id integer,
    author_role character varying(50),
    message text NOT NULL,
    is_internal boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: housekeeping_request_updates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.housekeeping_request_updates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: housekeeping_request_updates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.housekeeping_request_updates_id_seq OWNED BY public.housekeeping_request_updates.id;


--
-- Name: housekeeping_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.housekeeping_requests (
    id integer NOT NULL,
    request_number character varying(30) NOT NULL,
    requester_id integer,
    zone_id integer,
    location_text character varying(300) NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7),
    request_type character varying(50) DEFAULT 'cleaning'::character varying,
    urgency character varying(20) DEFAULT 'normal'::character varying,
    description text,
    photo_key text,
    photo_url text,
    status character varying(30) DEFAULT 'open'::character varying,
    assigned_to integer,
    assigned_at timestamp without time zone,
    assigned_by integer,
    completed_at timestamp without time zone,
    completion_notes text,
    completion_photo_key text,
    completion_photo_url text,
    completion_signature_hash character varying(64),
    verified_by integer,
    verified_at timestamp without time zone,
    sla_due_at timestamp without time zone,
    sla_breached boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: housekeeping_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.housekeeping_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: housekeeping_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.housekeeping_requests_id_seq OWNED BY public.housekeeping_requests.id;


--
-- Name: housekeeping_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.housekeeping_zones (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    floor character varying(50),
    building character varying(100),
    zone_type character varying(50) DEFAULT 'general'::character varying,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: housekeeping_zones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.housekeeping_zones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: housekeeping_zones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.housekeeping_zones_id_seq OWNED BY public.housekeeping_zones.id;


--
-- Name: hr_activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hr_activity_logs (
    id integer NOT NULL,
    hr_staff_uid uuid,
    action character varying(100) NOT NULL,
    staff_id integer,
    description text,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: hr_activity_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hr_activity_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hr_activity_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hr_activity_logs_id_seq OWNED BY public.hr_activity_logs.id;


--
-- Name: icd10_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.icd10_codes (
    id integer NOT NULL,
    code character varying(10) NOT NULL,
    description text NOT NULL,
    category character varying(100),
    is_active boolean DEFAULT true
);


--
-- Name: icd10_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.icd10_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: icd10_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.icd10_codes_id_seq OWNED BY public.icd10_codes.id;


--
-- Name: immunizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.immunizations (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    vaccine_name character varying(255) NOT NULL,
    vaccine_code character varying(50),
    dose_number integer,
    administered_at timestamp without time zone,
    administered_by uuid,
    lot_number character varying(100),
    site character varying(50),
    route character varying(50),
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: immunizations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.immunizations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: immunizations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.immunizations_id_seq OWNED BY public.immunizations.id;


--
-- Name: incident_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.incident_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: incident_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.incident_reports (
    id integer NOT NULL,
    report_number character varying(20) NOT NULL,
    reporter_id integer,
    incident_type character varying(50) NOT NULL,
    severity character varying(20) DEFAULT 'moderate'::character varying NOT NULL,
    title character varying(200) NOT NULL,
    description text NOT NULL,
    location character varying(200),
    incident_date timestamp without time zone NOT NULL,
    patient_involved boolean DEFAULT false,
    patient_id integer,
    patient_name character varying(200),
    witnesses text,
    immediate_action_taken text,
    status character varying(20) DEFAULT 'submitted'::character varying,
    assigned_to integer,
    priority character varying(20) DEFAULT 'normal'::character varying,
    admin_notes text,
    resolution text,
    resolved_at timestamp without time zone,
    resolved_by integer,
    is_anonymous boolean DEFAULT false,
    attachments text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: incident_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.incident_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: incident_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.incident_reports_id_seq OWNED BY public.incident_reports.id;


--
-- Name: infection_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.infection_cases (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    infection_site character varying(50) NOT NULL,
    pathogen character varying(255),
    isolation_type character varying(50),
    status character varying(50) DEFAULT 'active'::character varying,
    identified_at timestamp without time zone DEFAULT now(),
    resolved_at timestamp without time zone,
    reported_by uuid,
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: infection_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.infection_cases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: infection_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.infection_cases_id_seq OWNED BY public.infection_cases.id;


--
-- Name: insurance_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insurance_claims (
    id integer NOT NULL,
    claim_number character varying(30) NOT NULL,
    patient_uid uuid NOT NULL,
    invoice_id integer,
    insurance_provider character varying(255) NOT NULL,
    policy_number character varying(100) NOT NULL,
    claim_amount numeric(10,2) NOT NULL,
    approved_amount numeric(10,2),
    status character varying(50) DEFAULT 'submitted'::character varying NOT NULL,
    documents jsonb,
    submitted_at timestamp(6) without time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp(6) without time zone,
    rejection_reason text,
    created_at timestamp(6) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(6) without time zone DEFAULT now() NOT NULL
);


--
-- Name: insurance_claims_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.insurance_claims_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: insurance_claims_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.insurance_claims_id_seq OWNED BY public.insurance_claims.id;


--
-- Name: intake_output; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intake_output (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    io_type character varying(20) NOT NULL,
    category character varying(50) NOT NULL,
    amount_ml numeric(8,1) NOT NULL,
    description text,
    recorded_by uuid,
    recorded_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: intake_output_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.intake_output_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: intake_output_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.intake_output_id_seq OWNED BY public.intake_output.id;


--
-- Name: invalidated_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invalidated_tokens (
    jti character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    reason character varying(100) DEFAULT 'logout'::character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: investigation_booking_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investigation_booking_history (
    id integer NOT NULL,
    booking_id integer,
    from_status character varying(20),
    to_status character varying(20) NOT NULL,
    changed_by integer,
    changed_by_role character varying(30),
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: investigation_booking_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investigation_booking_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investigation_booking_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investigation_booking_history_id_seq OWNED BY public.investigation_booking_history.id;


--
-- Name: investigation_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investigation_bookings (
    id integer NOT NULL,
    booking_number character varying(30),
    patient_id integer,
    patient_phone character varying(20),
    patient_name character varying(255),
    selected_tests integer[],
    custom_test_names text,
    slip_photo_key text,
    slip_photo_url text,
    notes text,
    collection_type character varying(20) DEFAULT 'home'::character varying NOT NULL,
    collection_address text,
    collection_landmark text,
    collection_lat numeric(10,7),
    collection_lng numeric(10,7),
    preferred_date date,
    preferred_time_slot character varying(30),
    estimated_cost numeric(10,2),
    final_cost numeric(10,2),
    status character varying(20) DEFAULT 'BOOKED'::character varying,
    confirmed_by integer,
    confirmed_at timestamp without time zone,
    confirmation_notes text,
    actual_tests text,
    assigned_collector integer,
    dispatched_at timestamp without time zone,
    collector_phone character varying(20),
    collection_otp character varying(6),
    collected_at timestamp without time zone,
    collected_by integer,
    collection_notes text,
    processing_started_at timestamp without time zone,
    result_uploaded_at timestamp without time zone,
    result_uploaded_by integer,
    result_file_key text,
    result_file_url text,
    result_notes text,
    delivered_at timestamp without time zone,
    patient_notified_at timestamp without time zone,
    sla_confirm_target timestamp without time zone,
    sla_dispatch_target timestamp without time zone,
    sla_collect_target timestamp without time zone,
    sla_result_target timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    estimated_collection_mins integer,
    collector_lat numeric(10,7),
    collector_lng numeric(10,7),
    collection_tracking_active boolean DEFAULT false,
    collection_distance_km numeric(6,2)
);


--
-- Name: investigation_bookings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investigation_bookings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investigation_bookings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investigation_bookings_id_seq OWNED BY public.investigation_bookings.id;


--
-- Name: investigation_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investigation_files (
    id integer NOT NULL,
    investigation_id integer,
    file_name character varying(255) NOT NULL,
    file_path text,
    file_type character varying(50),
    file_size bigint,
    uploaded_by uuid,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes text,
    is_result boolean DEFAULT true
);


--
-- Name: investigation_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investigation_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investigation_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investigation_files_id_seq OWNED BY public.investigation_files.id;


--
-- Name: investigation_template_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investigation_template_tests (
    id integer NOT NULL,
    template_id integer,
    test_name character varying(255) NOT NULL,
    test_code character varying(50),
    normal_range character varying(100),
    unit character varying(50),
    cost double precision
);


--
-- Name: investigation_template_tests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investigation_template_tests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investigation_template_tests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investigation_template_tests_id_seq OWNED BY public.investigation_template_tests.id;


--
-- Name: investigation_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investigation_templates (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(100),
    description text,
    department_id integer,
    created_by uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: investigation_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investigation_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investigation_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investigation_templates_id_seq OWNED BY public.investigation_templates.id;


--
-- Name: investigation_test_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investigation_test_catalog (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    code character varying(50),
    category character varying(100),
    description text,
    normal_range text,
    unit character varying(50),
    default_cost numeric(10,2),
    turnaround_hours integer DEFAULT 24,
    requires_fasting boolean DEFAULT false,
    patient_instructions text,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    home_collection_surcharge numeric(10,2) DEFAULT 50.00
);


--
-- Name: investigation_test_catalog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investigation_test_catalog_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investigation_test_catalog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investigation_test_catalog_id_seq OWNED BY public.investigation_test_catalog.id;


--
-- Name: investigations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investigations (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    test_name character varying(255) NOT NULL,
    test_type character varying(100),
    status character varying(50) DEFAULT 'REQUESTED'::character varying NOT NULL,
    result_file text,
    file_key text,
    priority character varying(20) DEFAULT 'NORMAL'::character varying,
    requested_by uuid,
    requested_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp(6) without time zone,
    updated_at timestamp(6) without time zone NOT NULL,
    notified boolean DEFAULT false,
    notified_at timestamp without time zone,
    turnaround_target_hours integer DEFAULT 24,
    result_uploaded_at timestamp without time zone,
    urgent_alert_sent boolean DEFAULT false,
    patient_notified_at timestamp without time zone,
    patient_id integer
);


--
-- Name: investigations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investigations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investigations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investigations_id_seq OWNED BY public.investigations.id;


--
-- Name: investment_declarations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.investment_declarations (
    id integer NOT NULL,
    staff_uid uuid,
    financial_year character varying(10) NOT NULL,
    ppf numeric(10,2) DEFAULT 0,
    epf_voluntary numeric(10,2) DEFAULT 0,
    elss numeric(10,2) DEFAULT 0,
    lic_premium numeric(10,2) DEFAULT 0,
    nsc numeric(10,2) DEFAULT 0,
    home_loan_principal numeric(10,2) DEFAULT 0,
    tuition_fees numeric(10,2) DEFAULT 0,
    other_80c numeric(10,2) DEFAULT 0,
    health_insurance_self numeric(10,2) DEFAULT 0,
    health_insurance_parents numeric(10,2) DEFAULT 0,
    education_loan_interest numeric(10,2) DEFAULT 0,
    rent_paid_monthly numeric(10,2) DEFAULT 0,
    rent_receipt_provided boolean DEFAULT false,
    home_loan_interest numeric(10,2) DEFAULT 0,
    nps_contribution numeric(10,2) DEFAULT 0,
    status character varying(20) DEFAULT 'draft'::character varying,
    submitted_at timestamp without time zone,
    approved_by uuid,
    approved_at timestamp without time zone,
    proof_submitted boolean DEFAULT false,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: investment_declarations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.investment_declarations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: investment_declarations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.investment_declarations_id_seq OWNED BY public.investment_declarations.id;


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id integer NOT NULL,
    invoice_number character varying(30) NOT NULL,
    patient_uid uuid NOT NULL,
    appointment_id integer,
    type character varying(50) NOT NULL,
    items jsonb NOT NULL,
    subtotal numeric(10,2) NOT NULL,
    tax_amount numeric(10,2) DEFAULT 0 NOT NULL,
    discount_amount numeric(10,2) DEFAULT 0 NOT NULL,
    total_amount numeric(10,2) NOT NULL,
    paid_amount numeric(10,2) DEFAULT 0 NOT NULL,
    payment_status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    payment_method character varying(50),
    insurance_claim_id integer,
    notes text,
    issued_by uuid,
    issued_at timestamp(6) without time zone DEFAULT now() NOT NULL,
    paid_at timestamp(6) without time zone,
    due_date date,
    created_at timestamp(6) without time zone DEFAULT now() NOT NULL,
    updated_at timestamp(6) without time zone DEFAULT now() NOT NULL
);


--
-- Name: invoices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.invoices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: invoices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.invoices_id_seq OWNED BY public.invoices.id;


--
-- Name: leave_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_applications (
    id integer NOT NULL,
    staff_id integer,
    leave_type character varying(50) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    days_taken double precision,
    reason text,
    emergency_contact text,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    applied_by uuid,
    applied_date timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp(6) without time zone,
    review_notes text,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: leave_applications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leave_applications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leave_applications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leave_applications_id_seq OWNED BY public.leave_applications.id;


--
-- Name: leave_balance_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_balance_overrides (
    id integer NOT NULL,
    staff_id integer,
    leave_type character varying(50) NOT NULL,
    new_balance double precision,
    reason text,
    overridden_by uuid,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: leave_balance_overrides_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leave_balance_overrides_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leave_balance_overrides_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leave_balance_overrides_id_seq OWNED BY public.leave_balance_overrides.id;


--
-- Name: leave_encashments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_encashments (
    id integer NOT NULL,
    staff_uid uuid,
    encashment_type character varying(20) NOT NULL,
    leave_days integer NOT NULL,
    daily_rate numeric(10,2) NOT NULL,
    amount numeric(12,2) NOT NULL,
    financial_year character varying(10),
    payslip_id integer,
    fnf_id integer,
    approved_by uuid,
    approved_at timestamp without time zone,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: leave_encashments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leave_encashments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leave_encashments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leave_encashments_id_seq OWNED BY public.leave_encashments.id;


--
-- Name: leave_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_requests (
    id integer NOT NULL,
    staff_id integer,
    leave_type character varying(50),
    start_date date NOT NULL,
    end_date date NOT NULL,
    reason text,
    status character varying(50) DEFAULT 'pending'::character varying,
    approved_by uuid,
    approved_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: leave_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leave_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leave_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leave_requests_id_seq OWNED BY public.leave_requests.id;


--
-- Name: leave_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leave_types (
    id integer NOT NULL,
    leave_type character varying(50) NOT NULL,
    annual_entitlement integer,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: leave_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.leave_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: leave_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.leave_types_id_seq OWNED BY public.leave_types.id;


--
-- Name: legal_holds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_holds (
    id integer NOT NULL,
    user_uid uuid NOT NULL,
    reason text NOT NULL,
    held_by uuid,
    released_at timestamp without time zone,
    released_by uuid,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: legal_holds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.legal_holds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: legal_holds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.legal_holds_id_seq OWNED BY public.legal_holds.id;


--
-- Name: medical_activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medical_activity_logs (
    id integer NOT NULL,
    staff_uid uuid,
    action character varying(100) NOT NULL,
    patient_phone character varying(15),
    description text,
    consultation_id integer,
    investigation_id integer,
    urgent_flag boolean DEFAULT false,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: medical_activity_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.medical_activity_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: medical_activity_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.medical_activity_logs_id_seq OWNED BY public.medical_activity_logs.id;


--
-- Name: medical_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medical_records (
    id integer NOT NULL,
    patient_id uuid,
    doctor_id integer,
    record_type character varying(50),
    title character varying(255),
    description text,
    diagnosis text,
    treatment text,
    medications jsonb,
    lab_results jsonb,
    attachments jsonb,
    privacy_level character varying(20) DEFAULT 'RESTRICTED'::character varying,
    created_by uuid,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: medical_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.medical_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: medical_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.medical_records_id_seq OWNED BY public.medical_records.id;


--
-- Name: medication_administrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medication_administrations (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    prescription_id integer,
    order_id integer,
    medication_name character varying(255) NOT NULL,
    dose character varying(100),
    dosage character varying(100),
    route character varying(50),
    scheduled_time timestamp without time zone,
    administered_at timestamp without time zone,
    administered_by uuid,
    status character varying(50) DEFAULT 'scheduled'::character varying,
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: medication_administrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.medication_administrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: medication_administrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.medication_administrations_id_seq OWNED BY public.medication_administrations.id;


--
-- Name: medication_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medication_reminders (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    medication_name character varying(255) NOT NULL,
    dosage character varying(100),
    frequency character varying(100),
    reminder_times jsonb,
    start_date date,
    end_date date,
    is_active boolean DEFAULT true,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: medication_reminders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.medication_reminders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: medication_reminders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.medication_reminders_id_seq OWNED BY public.medication_reminders.id;


--
-- Name: medications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.medications (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    generic_name character varying(255),
    brand character varying(100),
    category character varying(100),
    dosage character varying(100),
    form character varying(50),
    price double precision,
    stock_quantity integer,
    expiry_date date,
    manufacturer character varying(255),
    prescription_required boolean DEFAULT false NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid
);


--
-- Name: medications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.medications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: medications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.medications_id_seq OWNED BY public.medications.id;


--
-- Name: notification_delivery_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_delivery_log (
    id integer NOT NULL,
    notification_id integer,
    status character varying(50) NOT NULL,
    error_type character varying(100),
    error_message text,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: notification_delivery_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_delivery_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_delivery_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_delivery_log_id_seq OWNED BY public.notification_delivery_log.id;


--
-- Name: notification_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_outbox (
    id integer NOT NULL,
    type character varying(20) DEFAULT 'push'::character varying NOT NULL,
    recipient_id integer,
    recipient_phone character varying(20),
    title character varying(255) DEFAULT ''::character varying NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_attempted_at timestamp without time zone,
    sent_at timestamp without time zone,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp without time zone,
    failure_reason text
);


--
-- Name: notification_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_outbox_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_outbox_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_outbox_id_seq OWNED BY public.notification_outbox.id;


--
-- Name: notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_templates (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    title_template text NOT NULL,
    message_template text NOT NULL,
    type character varying(50) NOT NULL,
    priority character varying(20) NOT NULL,
    variables jsonb,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: notification_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_templates_id_seq OWNED BY public.notification_templates.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    title character varying(255) NOT NULL,
    body text NOT NULL,
    type character varying(50) DEFAULT 'GENERAL'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'NORMAL'::character varying NOT NULL,
    data jsonb,
    is_read boolean DEFAULT false NOT NULL,
    scheduled_for timestamp(6) without time zone,
    sent_at timestamp(6) without time zone,
    read_at timestamp(6) without time zone,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: nurse_handovers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nurse_handovers (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    ward character varying(100),
    bed_number character varying(20),
    outgoing_nurse uuid NOT NULL,
    incoming_nurse uuid,
    shift character varying(50),
    patient_summary text,
    active_issues jsonb,
    pending_tasks jsonb,
    medications_due jsonb,
    special_instructions text,
    summary text,
    alerts jsonb,
    acknowledged boolean DEFAULT false,
    acknowledged_at timestamp without time zone,
    status character varying(20) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: nurse_handovers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nurse_handovers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nurse_handovers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nurse_handovers_id_seq OWNED BY public.nurse_handovers.id;


--
-- Name: onboarding_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.onboarding_tasks (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    task_name character varying(255),
    description text,
    completed boolean DEFAULT false,
    completed_at timestamp without time zone,
    due_date date,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: onboarding_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.onboarding_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: onboarding_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.onboarding_tasks_id_seq OWNED BY public.onboarding_tasks.id;


--
-- Name: order_sets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_sets (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    category character varying(100),
    orders jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_active boolean DEFAULT true,
    created_by uuid,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: order_sets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_sets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_sets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_sets_id_seq OWNED BY public.order_sets.id;


--
-- Name: ot_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ot_schedules (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    surgeon uuid NOT NULL,
    anesthetist uuid,
    procedure_name character varying(255) NOT NULL,
    procedure_code character varying(50),
    ot_room character varying(50),
    scheduled_date date NOT NULL,
    scheduled_time time without time zone,
    estimated_duration integer,
    actual_duration integer,
    status character varying(50) DEFAULT 'scheduled'::character varying,
    pre_op_checklist jsonb,
    equipment_needed text[],
    blood_arranged boolean DEFAULT false,
    consent_obtained boolean DEFAULT false,
    post_op_notes text,
    complications text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: ot_schedules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ot_schedules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ot_schedules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ot_schedules_id_seq OWNED BY public.ot_schedules.id;


--
-- Name: otp_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_codes (
    id integer NOT NULL,
    phone character varying(20) NOT NULL,
    otp_code character varying(10),
    code character varying(10),
    purpose character varying(50) DEFAULT 'login'::character varying,
    expires_at timestamp without time zone NOT NULL,
    used boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: otp_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.otp_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: otp_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.otp_codes_id_seq OWNED BY public.otp_codes.id;


--
-- Name: otp_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_logs (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    purpose character varying(50) NOT NULL,
    action character varying(50) NOT NULL,
    success boolean NOT NULL,
    failure_reason text,
    ip_address character varying(45),
    user_agent text,
    created_by uuid,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: otp_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.otp_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: otp_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.otp_logs_id_seq OWNED BY public.otp_logs.id;


--
-- Name: otp_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.otp_sessions (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    otp character varying(10) NOT NULL,
    purpose character varying(50) NOT NULL,
    user_id integer,
    expires_at timestamp(6) without time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: otp_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.otp_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: otp_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.otp_sessions_id_seq OWNED BY public.otp_sessions.id;


--
-- Name: overtime_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.overtime_requests (
    id integer NOT NULL,
    staff_id integer,
    date date NOT NULL,
    extra_hours numeric(4,2) NOT NULL,
    reason text NOT NULL,
    type character varying(20) DEFAULT 'comp_time'::character varying,
    status character varying(20) DEFAULT 'pending'::character varying,
    approved_by integer,
    approved_at timestamp without time zone,
    rejection_reason text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: overtime_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.overtime_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: overtime_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.overtime_requests_id_seq OWNED BY public.overtime_requests.id;


--
-- Name: password_reset_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_otps (
    id integer NOT NULL,
    user_id uuid NOT NULL,
    otp character varying(10) NOT NULL,
    expires_at timestamp(6) without time zone NOT NULL,
    used boolean DEFAULT false NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: password_reset_otps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.password_reset_otps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: password_reset_otps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.password_reset_otps_id_seq OWNED BY public.password_reset_otps.id;


--
-- Name: patient_allergies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_allergies (
    id integer NOT NULL,
    patient_id integer,
    patient_uid uuid,
    allergy_name character varying(255) NOT NULL,
    severity character varying(20) DEFAULT 'unknown'::character varying,
    reaction text,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: patient_allergies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patient_allergies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patient_allergies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patient_allergies_id_seq OWNED BY public.patient_allergies.id;


--
-- Name: patient_consents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_consents (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    consent_type character varying(100) NOT NULL,
    granted boolean DEFAULT true NOT NULL,
    granted_at timestamp without time zone DEFAULT now(),
    granted_by uuid,
    revoked_at timestamp without time zone,
    revoked_by uuid,
    ip_address character varying(45),
    notes text,
    status character varying(20) DEFAULT 'active'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: patient_consents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patient_consents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patient_consents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patient_consents_id_seq OWNED BY public.patient_consents.id;


--
-- Name: patient_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_feedback (
    id integer NOT NULL,
    doctor_id integer,
    rating double precision,
    review_text text,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: patient_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patient_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patient_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patient_feedback_id_seq OWNED BY public.patient_feedback.id;


--
-- Name: patient_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_records (
    id integer NOT NULL,
    patient_id integer,
    document_type character varying(30) DEFAULT 'other'::character varying NOT NULL,
    title character varying(255) NOT NULL,
    file_key text NOT NULL,
    file_url text,
    file_name character varying(500),
    file_size integer,
    file_mime character varying(100),
    source_hospital character varying(255),
    record_date date,
    notes text,
    is_verified boolean DEFAULT false,
    verified_by integer,
    verified_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: patient_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patient_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patient_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patient_records_id_seq OWNED BY public.patient_records.id;


--
-- Name: payment_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_transactions (
    id integer NOT NULL,
    invoice_id integer,
    amount numeric(10,2) NOT NULL,
    payment_method character varying(50) NOT NULL,
    transaction_ref character varying(255),
    status character varying(50) DEFAULT 'completed'::character varying NOT NULL,
    processed_by uuid,
    created_at timestamp(6) without time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_transactions_id_seq OWNED BY public.payment_transactions.id;


--
-- Name: payroll_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payroll_runs (
    id integer NOT NULL,
    month integer NOT NULL,
    year integer NOT NULL,
    status character varying(20) DEFAULT 'draft'::character varying,
    total_staff integer DEFAULT 0,
    total_gross numeric(14,2) DEFAULT 0,
    total_net numeric(14,2) DEFAULT 0,
    total_deductions numeric(14,2) DEFAULT 0,
    generated_by uuid,
    generated_at timestamp without time zone,
    locked_by uuid,
    locked_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: payroll_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payroll_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payroll_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payroll_runs_id_seq OWNED BY public.payroll_runs.id;


--
-- Name: payslip_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payslip_queries (
    id integer NOT NULL,
    payslip_id integer,
    staff_uid uuid NOT NULL,
    subject character varying(255) NOT NULL,
    description text NOT NULL,
    category character varying(30) DEFAULT 'general'::character varying,
    status character varying(20) DEFAULT 'open'::character varying,
    resolved_by uuid,
    resolved_at timestamp without time zone,
    resolution_note text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: payslip_queries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payslip_queries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payslip_queries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payslip_queries_id_seq OWNED BY public.payslip_queries.id;


--
-- Name: payslip_query_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payslip_query_replies (
    id integer NOT NULL,
    query_id integer,
    author_uid uuid NOT NULL,
    author_role character varying(20) NOT NULL,
    message text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: payslip_query_replies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payslip_query_replies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payslip_query_replies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payslip_query_replies_id_seq OWNED BY public.payslip_query_replies.id;


--
-- Name: payslips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payslips (
    id integer NOT NULL,
    payroll_run_id integer,
    staff_uid uuid,
    month integer NOT NULL,
    year integer NOT NULL,
    total_working_days integer DEFAULT 0,
    days_present integer DEFAULT 0,
    days_absent integer DEFAULT 0,
    days_leave integer DEFAULT 0,
    days_half integer DEFAULT 0,
    overtime_hours numeric(6,2) DEFAULT 0,
    overtime_rate numeric(10,2) DEFAULT 0,
    basic_earned numeric(12,2) DEFAULT 0,
    hra_earned numeric(12,2) DEFAULT 0,
    da_earned numeric(12,2) DEFAULT 0,
    special_allowance_earned numeric(12,2) DEFAULT 0,
    transport_allowance_earned numeric(12,2) DEFAULT 0,
    medical_allowance_earned numeric(12,2) DEFAULT 0,
    overtime_pay numeric(12,2) DEFAULT 0,
    bonus_this_month numeric(12,2) DEFAULT 0,
    gross_salary numeric(12,2) DEFAULT 0,
    pf_employee numeric(12,2) DEFAULT 0,
    esi_employee numeric(12,2) DEFAULT 0,
    professional_tax numeric(12,2) DEFAULT 0,
    tds numeric(12,2) DEFAULT 0,
    other_deductions numeric(12,2) DEFAULT 0,
    total_deductions numeric(12,2) DEFAULT 0,
    net_salary numeric(12,2) DEFAULT 0,
    pdf_key text,
    pdf_generated_at timestamp without time zone,
    status character varying(20) DEFAULT 'draft'::character varying,
    viewed_at timestamp without time zone,
    downloaded_at timestamp without time zone,
    issued_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    lop_days numeric(5,2) DEFAULT 0,
    lop_deduction numeric(12,2) DEFAULT 0,
    arrears_amount numeric(12,2) DEFAULT 0,
    advance_deduction numeric(12,2) DEFAULT 0,
    revision_note text
);


--
-- Name: payslips_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payslips_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payslips_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payslips_id_seq OWNED BY public.payslips.id;


--
-- Name: performance_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.performance_reviews (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    reviewer_id uuid,
    review_type character varying(50) DEFAULT 'annual'::character varying,
    period character varying(50),
    status character varying(50) DEFAULT 'pending'::character varying,
    due_date date,
    completed_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: performance_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.performance_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: performance_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.performance_reviews_id_seq OWNED BY public.performance_reviews.id;


--
-- Name: pharmacies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pharmacies (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    address text,
    latitude double precision,
    longitude double precision,
    phone character varying(15),
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: pharmacies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pharmacies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pharmacies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pharmacies_id_seq OWNED BY public.pharmacies.id;


--
-- Name: pharmacy_activity_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pharmacy_activity_logs (
    id integer NOT NULL,
    staff_uid uuid,
    action character varying(100) NOT NULL,
    patient_phone character varying(15),
    order_id integer,
    old_status character varying(50),
    new_status character varying(50),
    notes text,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: pharmacy_activity_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pharmacy_activity_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pharmacy_activity_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pharmacy_activity_logs_id_seq OWNED BY public.pharmacy_activity_logs.id;


--
-- Name: pharmacy_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pharmacy_catalog (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    generic_name character varying(255),
    category character varying(100),
    manufacturer character varying(255),
    unit_price numeric(10,2),
    pack_size character varying(50),
    requires_prescription boolean DEFAULT true,
    in_stock boolean DEFAULT true,
    stock_quantity integer DEFAULT 0,
    reorder_level integer DEFAULT 10,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: pharmacy_catalog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pharmacy_catalog_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pharmacy_catalog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pharmacy_catalog_id_seq OWNED BY public.pharmacy_catalog.id;


--
-- Name: pharmacy_order_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pharmacy_order_history (
    id integer NOT NULL,
    order_id integer,
    from_status character varying(30),
    to_status character varying(30) NOT NULL,
    changed_by integer,
    changed_by_role character varying(30),
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: pharmacy_order_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pharmacy_order_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pharmacy_order_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pharmacy_order_history_id_seq OWNED BY public.pharmacy_order_history.id;


--
-- Name: pharmacy_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pharmacy_orders (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    order_note text NOT NULL,
    medication text,
    status character varying(50) DEFAULT 'PENDING'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'NORMAL'::character varying,
    file_key text,
    prescribed_by uuid,
    dispensed_by uuid,
    ordered_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    dispensed_at timestamp(6) without time zone,
    updated_at timestamp(6) without time zone NOT NULL,
    order_number character varying(30),
    patient_name character varying(255),
    prescription_photo_key text,
    prescription_photo_url text,
    delivery_type character varying(20) DEFAULT 'delivery'::character varying,
    delivery_address text,
    delivery_landmark text,
    delivery_lat numeric(10,7),
    delivery_lng numeric(10,7),
    delivery_phone character varying(20),
    confirmed_by integer,
    confirmed_at timestamp without time zone,
    confirmation_notes text,
    items_list jsonb,
    preparing_at timestamp without time zone,
    dispatched_at timestamp without time zone,
    dispatched_by integer,
    delivery_person character varying(255),
    delivery_person_phone character varying(20),
    delivered_at timestamp without time zone,
    delivery_otp character varying(6),
    cancellation_reason text,
    cancelled_at timestamp without time zone,
    patient_notified_at timestamp without time zone,
    sla_confirm_target timestamp without time zone,
    sla_dispatch_target timestamp without time zone,
    sla_delivery_target timestamp without time zone,
    estimated_delivery_mins integer,
    delivery_started_at timestamp without time zone,
    delivery_tracking_active boolean DEFAULT false,
    delivery_distance_km numeric(6,2),
    patient_id integer,
    prescription_url text,
    total_amount numeric(10,2) DEFAULT 0,
    payment_status character varying(50) DEFAULT 'pending'::character varying,
    assigned_pharmacist uuid,
    token_number character varying(50),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: pharmacy_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pharmacy_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pharmacy_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pharmacy_orders_id_seq OWNED BY public.pharmacy_orders.id;


--
-- Name: prescriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prescriptions (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    doctor_uid uuid,
    medication_name character varying(255) NOT NULL,
    dosage character varying(100),
    frequency character varying(100),
    route character varying(50),
    duration_days integer,
    quantity integer,
    refills integer DEFAULT 0,
    instructions text,
    status character varying(50) DEFAULT 'active'::character varying,
    issued_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone,
    dispensed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: prescriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prescriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prescriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prescriptions_id_seq OWNED BY public.prescriptions.id;


--
-- Name: quality_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quality_incidents (
    id integer NOT NULL,
    incident_number character varying(30),
    reported_by uuid NOT NULL,
    patient_uid uuid,
    incident_type character varying(50) NOT NULL,
    severity character varying(20) NOT NULL,
    description text NOT NULL,
    location character varying(255),
    date_occurred date NOT NULL,
    status character varying(50) DEFAULT 'reported'::character varying,
    investigation text,
    corrective_action text,
    resolved_by uuid,
    resolved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: quality_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quality_incidents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quality_incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quality_incidents_id_seq OWNED BY public.quality_incidents.id;


--
-- Name: quarantined_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quarantined_files (
    id integer NOT NULL,
    file_name character varying(255),
    storage_key text,
    file_size bigint,
    uploaded_by uuid,
    quarantine_reason text,
    scan_result text,
    is_reviewed boolean DEFAULT false,
    reviewed_by uuid,
    reviewed_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: quarantined_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.quarantined_files_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: quarantined_files_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.quarantined_files_id_seq OWNED BY public.quarantined_files.id;


--
-- Name: radiology_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.radiology_orders (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    modality character varying(50) NOT NULL,
    body_part character varying(100) NOT NULL,
    clinical_indication text NOT NULL,
    priority character varying(20) DEFAULT 'routine'::character varying,
    status character varying(50) DEFAULT 'ordered'::character varying,
    ordered_by uuid,
    radiologist uuid,
    report text,
    report_completed_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: radiology_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.radiology_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: radiology_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.radiology_orders_id_seq OWNED BY public.radiology_orders.id;


--
-- Name: referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referrals (
    id integer NOT NULL,
    referral_number character varying(30),
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    referring_doctor uuid NOT NULL,
    referred_to_doctor uuid,
    referred_to_department character varying(100) NOT NULL,
    referral_type character varying(20) DEFAULT 'internal'::character varying,
    reason text NOT NULL,
    urgency character varying(20) DEFAULT 'routine'::character varying,
    clinical_summary text,
    status character varying(50) DEFAULT 'pending'::character varying,
    response_notes text,
    responded_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: referrals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.referrals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: referrals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.referrals_id_seq OWNED BY public.referrals.id;


--
-- Name: replacement_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replacement_requests (
    id integer NOT NULL,
    leave_request_id integer,
    requester_id integer,
    replacement_staff_id integer,
    dates text NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    requester_message text,
    responder_message text,
    requested_at timestamp without time zone DEFAULT now(),
    responded_at timestamp without time zone,
    hr_approved_at timestamp without time zone,
    hr_approved_by integer
);


--
-- Name: replacement_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.replacement_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: replacement_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.replacement_requests_id_seq OWNED BY public.replacement_requests.id;


--
-- Name: report_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_updates (
    id integer NOT NULL,
    report_type character varying(20) NOT NULL,
    report_id integer NOT NULL,
    author_id integer,
    author_role character varying(50),
    message text NOT NULL,
    is_internal boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: report_updates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.report_updates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: report_updates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.report_updates_id_seq OWNED BY public.report_updates.id;


--
-- Name: revision_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.revision_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: salary_advances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salary_advances (
    id integer NOT NULL,
    staff_uid uuid,
    amount numeric(12,2) NOT NULL,
    reason text NOT NULL,
    approved_by uuid,
    approved_at timestamp without time zone,
    status character varying(20) DEFAULT 'pending'::character varying,
    monthly_deduction numeric(10,2) NOT NULL,
    total_deducted numeric(12,2) DEFAULT 0,
    months_remaining integer,
    deduction_start_month integer,
    deduction_start_year integer,
    fully_cleared_at timestamp without time zone,
    notes text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: salary_advances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.salary_advances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: salary_advances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.salary_advances_id_seq OWNED BY public.salary_advances.id;


--
-- Name: salary_arrears; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salary_arrears (
    id integer NOT NULL,
    staff_uid uuid,
    revision_id integer,
    from_month integer NOT NULL,
    from_year integer NOT NULL,
    to_month integer NOT NULL,
    to_year integer NOT NULL,
    arrears_amount numeric(12,2) NOT NULL,
    paid_in_month integer,
    paid_in_year integer,
    payslip_id integer,
    status character varying(20) DEFAULT 'pending'::character varying,
    calculated_at timestamp without time zone DEFAULT now()
);


--
-- Name: salary_arrears_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.salary_arrears_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: salary_arrears_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.salary_arrears_id_seq OWNED BY public.salary_arrears.id;


--
-- Name: salary_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salary_revisions (
    id integer NOT NULL,
    revision_number character varying(30) NOT NULL,
    staff_uid uuid,
    revision_type character varying(20) NOT NULL,
    current_basic numeric(12,2),
    proposed_basic numeric(12,2),
    current_gross numeric(12,2),
    proposed_gross numeric(12,2),
    increment_amount numeric(12,2),
    increment_pct numeric(5,2),
    bonus_amount numeric(12,2),
    bonus_reason text,
    other_changes jsonb,
    effective_from date NOT NULL,
    reason text NOT NULL,
    proposed_by uuid,
    proposed_at timestamp without time zone DEFAULT now(),
    hr_signed_by uuid,
    hr_signed_at timestamp without time zone,
    hr_comment text,
    admin_signed_by uuid,
    admin_signed_at timestamp without time zone,
    admin_comment text,
    status character varying(30) DEFAULT 'pending_hr'::character varying,
    rejected_by uuid,
    rejected_at timestamp without time zone,
    rejection_reason text,
    applied_at timestamp without time zone,
    signature_hash character varying(64),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: salary_revisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.salary_revisions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: salary_revisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.salary_revisions_id_seq OWNED BY public.salary_revisions.id;


--
-- Name: scheduled_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_notifications (
    id integer NOT NULL,
    user_id integer,
    type character varying(50) NOT NULL,
    data jsonb,
    send_at timestamp without time zone NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    sent_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: scheduled_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scheduled_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scheduled_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scheduled_notifications_id_seq OWNED BY public.scheduled_notifications.id;


--
-- Name: sos_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sos_alerts (
    id integer NOT NULL,
    uid uuid,
    phone character varying(15) NOT NULL,
    latitude double precision,
    longitude double precision,
    location_name character varying(255),
    alert_type character varying(50) DEFAULT 'GENERAL'::character varying,
    severity character varying(20) DEFAULT 'MEDIUM'::character varying NOT NULL,
    message text,
    status character varying(50) DEFAULT 'ACTIVE'::character varying NOT NULL,
    responded_by uuid,
    ip_address character varying(45),
    device_info text,
    raised_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    responded_at timestamp(6) without time zone,
    resolved_at timestamp(6) without time zone,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: sos_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sos_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sos_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sos_alerts_id_seq OWNED BY public.sos_alerts.id;


--
-- Name: sos_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sos_services (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    phone character varying(20),
    type character varying(50) DEFAULT 'hospital'::character varying,
    address text,
    latitude double precision,
    longitude double precision,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: sos_services_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sos_services_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sos_services_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sos_services_id_seq OWNED BY public.sos_services.id;


--
-- Name: staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff (
    id integer NOT NULL,
    user_id uuid,
    employee_id character varying(50),
    "position" character varying(100),
    department character varying(100),
    shift character varying(50),
    salary double precision,
    hire_date date,
    join_date date,
    supervisor_id integer,
    emergency_contact jsonb,
    skills text[],
    certifications text[],
    notes text,
    is_active boolean DEFAULT true NOT NULL,
    on_leave boolean DEFAULT false NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    updated_by uuid,
    created_by uuid,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    performance_rating numeric(3,1),
    last_review_date date,
    name character varying(255),
    designation character varying(100)
);


--
-- Name: staff_attendance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_attendance (
    id integer NOT NULL,
    staff_id integer NOT NULL,
    staff_uid uuid,
    type character varying(20),
    location character varying(255),
    ip_address character varying(45),
    device_info text,
    check_in_time timestamp(6) without time zone,
    "timestamp" timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    attendance_status character varying(20),
    minutes_late integer,
    overtime_hours numeric(4,2) DEFAULT 0,
    check_out_time timestamp without time zone
);


--
-- Name: staff_attendance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_attendance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_attendance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_attendance_id_seq OWNED BY public.staff_attendance.id;


--
-- Name: staff_auth_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_auth_sessions (
    id integer NOT NULL,
    staff_id integer,
    device_id character varying(255),
    session_token text NOT NULL,
    expires_at timestamp(6) without time zone NOT NULL,
    ip_address character varying(45),
    last_activity timestamp(6) without time zone,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: staff_auth_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_auth_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_auth_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_auth_sessions_id_seq OWNED BY public.staff_auth_sessions.id;


--
-- Name: staff_breaks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_breaks (
    id integer NOT NULL,
    attendance_id integer,
    staff_id integer,
    break_start timestamp without time zone NOT NULL,
    break_end timestamp without time zone,
    duration_minutes integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: staff_breaks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_breaks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_breaks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_breaks_id_seq OWNED BY public.staff_breaks.id;


--
-- Name: staff_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_devices (
    id integer NOT NULL,
    staff_id integer,
    device_id character varying(255) NOT NULL,
    device_name character varying(255),
    device_token text,
    is_active boolean DEFAULT true NOT NULL,
    registered_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    registered_location character varying(255),
    trust_expires_at timestamp(6) without time zone,
    last_used timestamp(6) without time zone
);


--
-- Name: staff_devices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_devices_id_seq OWNED BY public.staff_devices.id;


--
-- Name: staff_grievances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_grievances (
    id integer NOT NULL,
    grievance_number character varying(20) NOT NULL,
    reporter_id integer,
    grievance_type character varying(50) NOT NULL,
    subject character varying(200) NOT NULL,
    description text NOT NULL,
    against_whom character varying(200),
    department character varying(100),
    incident_date date,
    is_anonymous boolean DEFAULT false,
    status character varying(20) DEFAULT 'submitted'::character varying,
    priority character varying(20) DEFAULT 'normal'::character varying,
    assigned_to integer,
    confidential boolean DEFAULT true,
    hr_notes text,
    resolution text,
    resolved_at timestamp without time zone,
    resolved_by integer,
    acknowledgement_sent boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: staff_grievances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_grievances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_grievances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_grievances_id_seq OWNED BY public.staff_grievances.id;


--
-- Name: staff_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_id_seq OWNED BY public.staff.id;


--
-- Name: staff_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_messages (
    id integer NOT NULL,
    sender_uid uuid NOT NULL,
    recipient_uid uuid NOT NULL,
    patient_uid uuid,
    subject character varying(255),
    body text NOT NULL,
    priority character varying(20) DEFAULT 'normal'::character varying,
    is_read boolean DEFAULT false,
    read_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: staff_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_messages_id_seq OWNED BY public.staff_messages.id;


--
-- Name: staff_onboarding_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_onboarding_tasks (
    id integer NOT NULL,
    staff_id integer,
    task_name character varying(255),
    status character varying(50),
    completed_at timestamp(6) without time zone,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: staff_onboarding_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_onboarding_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_onboarding_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_onboarding_tasks_id_seq OWNED BY public.staff_onboarding_tasks.id;


--
-- Name: staff_performance_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_performance_reviews (
    id integer NOT NULL,
    staff_id integer,
    reviewer_id uuid,
    rating double precision,
    review_period character varying(50),
    reviewer_comments text,
    goals_achieved text,
    areas_for_improvement text,
    future_goals text,
    training_recommendations text,
    review_date date,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: staff_performance_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_performance_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_performance_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_performance_reviews_id_seq OWNED BY public.staff_performance_reviews.id;


--
-- Name: staff_salary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_salary (
    id integer NOT NULL,
    staff_uid uuid NOT NULL,
    basic_salary numeric(12,2) DEFAULT 0 NOT NULL,
    hra_pct numeric(5,2) DEFAULT 40.00,
    da_pct numeric(5,2) DEFAULT 10.00,
    special_allowance numeric(12,2) DEFAULT 0,
    transport_allowance numeric(12,2) DEFAULT 0,
    medical_allowance numeric(12,2) DEFAULT 0,
    pf_employee_pct numeric(5,2) DEFAULT 12.00,
    pf_employer_pct numeric(5,2) DEFAULT 12.00,
    esi_applicable boolean DEFAULT false,
    professional_tax numeric(8,2) DEFAULT 200,
    tds_monthly numeric(12,2) DEFAULT 0,
    designation character varying(200),
    department character varying(200),
    employee_id character varying(50),
    date_of_joining date,
    pan_number character varying(20),
    pf_uan character varying(30),
    bank_account character varying(50),
    bank_name character varying(100),
    bank_ifsc character varying(20),
    effective_from date DEFAULT CURRENT_DATE,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    notice_period_days integer DEFAULT 30,
    dob date
);


--
-- Name: staff_salary_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_salary_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_salary_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_salary_id_seq OWNED BY public.staff_salary.id;


--
-- Name: staff_shift_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_shift_assignments (
    id integer NOT NULL,
    staff_id integer,
    shift_id integer,
    effective_from date DEFAULT CURRENT_DATE,
    effective_to date,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: staff_shift_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_shift_assignments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_shift_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_shift_assignments_id_seq OWNED BY public.staff_shift_assignments.id;


--
-- Name: staff_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staff_shifts (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    grace_period_minutes integer DEFAULT 15,
    late_threshold_minutes integer DEFAULT 30,
    absent_threshold_minutes integer DEFAULT 60,
    department character varying(100),
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: staff_shifts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.staff_shifts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: staff_shifts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.staff_shifts_id_seq OWNED BY public.staff_shifts.id;


--
-- Name: step_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.step_profiles (
    id integer NOT NULL,
    user_uid uuid NOT NULL,
    display_name character varying(100) NOT NULL,
    display_color character varying(7) DEFAULT '#2196F3'::character varying NOT NULL,
    daily_goal integer DEFAULT 8000 NOT NULL,
    opted_in boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: step_profiles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.step_profiles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: step_profiles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.step_profiles_id_seq OWNED BY public.step_profiles.id;


--
-- Name: step_rewards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.step_rewards (
    id integer NOT NULL,
    user_uid uuid NOT NULL,
    reward_type character varying(50) NOT NULL,
    reward_month character varying(7),
    discount_pct integer DEFAULT 0 NOT NULL,
    description text NOT NULL,
    is_applied boolean DEFAULT false NOT NULL,
    expires_at timestamp(6) without time zone,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: step_rewards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.step_rewards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: step_rewards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.step_rewards_id_seq OWNED BY public.step_rewards.id;


--
-- Name: step_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.step_sessions (
    id integer NOT NULL,
    user_uid uuid NOT NULL,
    started_at timestamp(6) without time zone NOT NULL,
    ended_at timestamp(6) without time zone,
    steps integer DEFAULT 0 NOT NULL,
    distance_meters double precision DEFAULT 0 NOT NULL,
    duration_seconds integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: step_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.step_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: step_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.step_sessions_id_seq OWNED BY public.step_sessions.id;


--
-- Name: system_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_alerts (
    id integer NOT NULL,
    alert_type character varying(100) NOT NULL,
    severity character varying(20),
    message text,
    related_file_id integer,
    resolved boolean DEFAULT false NOT NULL,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: system_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_alerts_id_seq OWNED BY public.system_alerts.id;


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    id integer NOT NULL,
    key character varying(255) NOT NULL,
    value jsonb,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: system_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_settings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_settings_id_seq OWNED BY public.system_settings.id;


--
-- Name: totp_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.totp_challenges (
    id integer NOT NULL,
    admin_id integer NOT NULL,
    challenge_token character varying(255) NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    used boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: totp_challenges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.totp_challenges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: totp_challenges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.totp_challenges_id_seq OWNED BY public.totp_challenges.id;


--
-- Name: user_action_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_action_logs (
    id integer NOT NULL,
    user_id uuid,
    action character varying(100) NOT NULL,
    target_user_id uuid,
    details jsonb,
    ip_address character varying(45),
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_action_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_action_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_action_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_action_logs_id_seq OWNED BY public.user_action_logs.id;


--
-- Name: user_deactivation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_deactivation_log (
    id integer NOT NULL,
    user_id uuid NOT NULL,
    deactivated_by uuid,
    deactivation_reason text,
    data_transferred_to uuid,
    deactivated_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip_address character varying(45),
    user_data jsonb
);


--
-- Name: user_deactivation_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_deactivation_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_deactivation_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_deactivation_log_id_seq OWNED BY public.user_deactivation_log.id;


--
-- Name: user_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_devices (
    id integer NOT NULL,
    user_uid uuid NOT NULL,
    device_id character varying(255) NOT NULL,
    device_name character varying(255),
    platform character varying(50),
    app_version character varying(50),
    os_version character varying(50),
    fcm_token text,
    last_active timestamp(6) without time zone,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_devices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_devices_id_seq OWNED BY public.user_devices.id;


--
-- Name: user_reactivation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_reactivation_log (
    id integer NOT NULL,
    user_id uuid NOT NULL,
    reactivated_by uuid,
    reactivation_reason text,
    reactivated_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip_address character varying(45)
);


--
-- Name: user_reactivation_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_reactivation_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_reactivation_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_reactivation_log_id_seq OWNED BY public.user_reactivation_log.id;


--
-- Name: user_role_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_role_audit (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    old_role character varying(50),
    new_role character varying(50),
    changed_by_uid uuid,
    reason text,
    action_type character varying(50),
    changed_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_role_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_role_audit_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_role_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_role_audit_id_seq OWNED BY public.user_role_audit.id;


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id integer NOT NULL,
    role_name character varying(50) NOT NULL,
    role_description text,
    permissions jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_roles_id_seq OWNED BY public.user_roles.id;


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id integer NOT NULL,
    user_id uuid,
    device_type character varying(50),
    platform character varying(50),
    expires_at timestamp(6) without time zone,
    created_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_sessions_id_seq OWNED BY public.user_sessions.id;


--
-- Name: user_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_status_history (
    id integer NOT NULL,
    user_id uuid NOT NULL,
    previous_status character varying(50),
    new_status character varying(50) NOT NULL,
    changed_by uuid,
    change_reason text,
    changed_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip_address character varying(45)
);


--
-- Name: user_status_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_status_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_status_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_status_history_id_seq OWNED BY public.user_status_history.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    uid uuid DEFAULT gen_random_uuid() NOT NULL,
    phone character varying(15) NOT NULL,
    name character varying(255),
    gender character varying(20),
    address text,
    email character varying(255),
    birthday date,
    anniversary date,
    profile_picture text,
    role character varying(50) DEFAULT 'PATIENT'::character varying,
    is_active boolean DEFAULT true NOT NULL,
    registered_at timestamp(6) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    pan_number character varying(20),
    abha_number character varying(20),
    abha_address character varying(255),
    status character varying(20) DEFAULT 'active'::character varying,
    device_token text,
    created_by uuid,
    updated_by uuid
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: vital_signs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vital_signs (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    type character varying(100) NOT NULL,
    value numeric,
    unit character varying(50),
    recorded_date timestamp without time zone DEFAULT now(),
    recorded_by uuid,
    encounter_id character varying(50),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: vital_signs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vital_signs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vital_signs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vital_signs_id_seq OWNED BY public.vital_signs.id;


--
-- Name: vitals_chart; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vitals_chart (
    id integer NOT NULL,
    patient_uid uuid NOT NULL,
    encounter_id character varying(50),
    heart_rate numeric(6,1),
    systolic_bp numeric(6,1),
    diastolic_bp numeric(6,1),
    temperature numeric(5,2),
    spo2 numeric(5,2),
    respiratory_rate numeric(5,1),
    blood_glucose numeric(6,1),
    pain_score numeric(4,1),
    weight_kg numeric(7,2),
    height_cm numeric(6,1),
    gcs_score smallint,
    supplemental_o2 boolean DEFAULT false,
    o2_flow_rate numeric(5,1),
    consciousness character varying(5),
    notes text,
    recorded_by uuid,
    recorded_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: vitals_chart_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vitals_chart_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vitals_chart_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vitals_chart_id_seq OWNED BY public.vitals_chart.id;


--
-- Name: wards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wards (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    floor integer DEFAULT 1,
    department_id integer,
    total_beds integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: wards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wards_id_seq OWNED BY public.wards.id;


--
-- Name: abdm_consents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abdm_consents ALTER COLUMN id SET DEFAULT nextval('public.abdm_consents_id_seq'::regclass);


--
-- Name: abdm_data_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abdm_data_requests ALTER COLUMN id SET DEFAULT nextval('public.abdm_data_requests_id_seq'::regclass);


--
-- Name: admin_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions ALTER COLUMN id SET DEFAULT nextval('public.admin_actions_id_seq'::regclass);


--
-- Name: admin_activity_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_activity_logs ALTER COLUMN id SET DEFAULT nextval('public.admin_activity_logs_id_seq'::regclass);


--
-- Name: admissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admissions ALTER COLUMN id SET DEFAULT nextval('public.admissions_id_seq'::regclass);


--
-- Name: admissions encounter_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admissions ALTER COLUMN encounter_id SET DEFAULT ((('ENC-'::text || to_char(now(), 'YYYYMMDD'::text)) || '-'::text) || lpad((nextval('public.admissions_id_seq'::regclass))::text, 4, '0'::text));


--
-- Name: advance_deductions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.advance_deductions ALTER COLUMN id SET DEFAULT nextval('public.advance_deductions_id_seq'::regclass);


--
-- Name: allergies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergies ALTER COLUMN id SET DEFAULT nextval('public.allergies_id_seq'::regclass);


--
-- Name: annual_review_reminders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_review_reminders ALTER COLUMN id SET DEFAULT nextval('public.annual_review_reminders_id_seq'::regclass);


--
-- Name: annual_tax_summaries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_tax_summaries ALTER COLUMN id SET DEFAULT nextval('public.annual_tax_summaries_id_seq'::regclass);


--
-- Name: anomalies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomalies ALTER COLUMN id SET DEFAULT nextval('public.anomalies_id_seq'::regclass);


--
-- Name: api_access_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_access_logs ALTER COLUMN id SET DEFAULT nextval('public.api_access_logs_id_seq'::regclass);


--
-- Name: appointment_archive id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_archive ALTER COLUMN id SET DEFAULT nextval('public.appointment_archive_id_seq'::regclass);


--
-- Name: appointment_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_documents ALTER COLUMN id SET DEFAULT nextval('public.appointment_documents_id_seq'::regclass);


--
-- Name: appointment_status_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_status_history ALTER COLUMN id SET DEFAULT nextval('public.appointment_status_history_id_seq'::regclass);


--
-- Name: appointments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments ALTER COLUMN id SET DEFAULT nextval('public.appointments_id_seq'::regclass);


--
-- Name: attendance_disputes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_disputes ALTER COLUMN id SET DEFAULT nextval('public.attendance_disputes_id_seq'::regclass);


--
-- Name: attendance_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_logs ALTER COLUMN id SET DEFAULT nextval('public.attendance_logs_id_seq'::regclass);


--
-- Name: attendance_regularization id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_regularization ALTER COLUMN id SET DEFAULT nextval('public.attendance_regularization_id_seq'::regclass);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: auth_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_logs ALTER COLUMN id SET DEFAULT nextval('public.auth_logs_id_seq'::regclass);


--
-- Name: batch_upload_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_upload_logs ALTER COLUMN id SET DEFAULT nextval('public.batch_upload_logs_id_seq'::regclass);


--
-- Name: bed_transfers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bed_transfers ALTER COLUMN id SET DEFAULT nextval('public.bed_transfers_id_seq'::regclass);


--
-- Name: beds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beds ALTER COLUMN id SET DEFAULT nextval('public.beds_id_seq'::regclass);


--
-- Name: blood_banks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blood_banks ALTER COLUMN id SET DEFAULT nextval('public.blood_banks_id_seq'::regclass);


--
-- Name: blood_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blood_requests ALTER COLUMN id SET DEFAULT nextval('public.blood_requests_id_seq'::regclass);


--
-- Name: bulk_operation_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_operation_logs ALTER COLUMN id SET DEFAULT nextval('public.bulk_operation_logs_id_seq'::regclass);


--
-- Name: bulk_revision_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_revision_jobs ALTER COLUMN id SET DEFAULT nextval('public.bulk_revision_jobs_id_seq'::regclass);


--
-- Name: canary_checks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canary_checks ALTER COLUMN id SET DEFAULT nextval('public.canary_checks_id_seq'::regclass);


--
-- Name: cds_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cds_alerts ALTER COLUMN id SET DEFAULT nextval('public.cds_alerts_id_seq'::regclass);


--
-- Name: clinical_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_alerts ALTER COLUMN id SET DEFAULT nextval('public.clinical_alerts_id_seq'::regclass);


--
-- Name: clinical_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_notes ALTER COLUMN id SET DEFAULT nextval('public.clinical_notes_id_seq'::regclass);


--
-- Name: clinical_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_orders ALTER COLUMN id SET DEFAULT nextval('public.clinical_orders_id_seq'::regclass);


--
-- Name: clinical_protocols id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_protocols ALTER COLUMN id SET DEFAULT nextval('public.clinical_protocols_id_seq'::regclass);


--
-- Name: consultations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consultations ALTER COLUMN id SET DEFAULT nextval('public.consultations_id_seq'::regclass);


--
-- Name: data_breaches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_breaches ALTER COLUMN id SET DEFAULT nextval('public.data_breaches_id_seq'::regclass);


--
-- Name: data_breaches breach_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_breaches ALTER COLUMN breach_id SET DEFAULT ((('BRH-'::text || to_char(now(), 'YYYYMM'::text)) || '-'::text) || lpad((nextval('public.data_breaches_id_seq'::regclass))::text, 4, '0'::text));


--
-- Name: delivery_location_updates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_location_updates ALTER COLUMN id SET DEFAULT nextval('public.delivery_location_updates_id_seq'::regclass);


--
-- Name: department_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_audit_log ALTER COLUMN id SET DEFAULT nextval('public.department_audit_log_id_seq'::regclass);


--
-- Name: departments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments ALTER COLUMN id SET DEFAULT nextval('public.departments_id_seq'::regclass);


--
-- Name: devices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices ALTER COLUMN id SET DEFAULT nextval('public.devices_id_seq'::regclass);


--
-- Name: diagnoses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnoses ALTER COLUMN id SET DEFAULT nextval('public.diagnoses_id_seq'::regclass);


--
-- Name: diet_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diet_orders ALTER COLUMN id SET DEFAULT nextval('public.diet_orders_id_seq'::regclass);


--
-- Name: discharge_summaries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discharge_summaries ALTER COLUMN id SET DEFAULT nextval('public.discharge_summaries_id_seq'::regclass);


--
-- Name: doctors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors ALTER COLUMN id SET DEFAULT nextval('public.doctors_id_seq'::regclass);


--
-- Name: drug_interactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drug_interactions ALTER COLUMN id SET DEFAULT nextval('public.drug_interactions_id_seq'::regclass);


--
-- Name: e_prescriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e_prescriptions ALTER COLUMN id SET DEFAULT nextval('public.e_prescriptions_id_seq'::regclass);


--
-- Name: emergency_services id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_services ALTER COLUMN id SET DEFAULT nextval('public.emergency_services_id_seq'::regclass);


--
-- Name: failed_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_notifications ALTER COLUMN id SET DEFAULT nextval('public.failed_notifications_id_seq'::regclass);


--
-- Name: feature_flags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags ALTER COLUMN id SET DEFAULT nextval('public.feature_flags_id_seq'::regclass);


--
-- Name: feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback ALTER COLUMN id SET DEFAULT nextval('public.feedback_id_seq'::regclass);


--
-- Name: feedback_responses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_responses ALTER COLUMN id SET DEFAULT nextval('public.feedback_responses_id_seq'::regclass);


--
-- Name: file_access_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_access_logs ALTER COLUMN id SET DEFAULT nextval('public.file_access_logs_id_seq'::regclass);


--
-- Name: file_deletion_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_deletion_log ALTER COLUMN id SET DEFAULT nextval('public.file_deletion_log_id_seq'::regclass);


--
-- Name: file_metadata id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_metadata ALTER COLUMN id SET DEFAULT nextval('public.file_metadata_id_seq'::regclass);


--
-- Name: full_final_settlements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.full_final_settlements ALTER COLUMN id SET DEFAULT nextval('public.full_final_settlements_id_seq'::regclass);


--
-- Name: gdpr_erasure_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_erasure_log ALTER COLUMN id SET DEFAULT nextval('public.gdpr_erasure_log_id_seq'::regclass);


--
-- Name: geofence_breaches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_breaches ALTER COLUMN id SET DEFAULT nextval('public.geofence_breaches_id_seq'::regclass);


--
-- Name: health_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_records ALTER COLUMN id SET DEFAULT nextval('public.health_records_id_seq'::regclass);


--
-- Name: hipaa_access_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hipaa_access_log ALTER COLUMN id SET DEFAULT nextval('public.hipaa_access_log_id_seq'::regclass);


--
-- Name: hospitals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hospitals ALTER COLUMN id SET DEFAULT nextval('public.hospitals_id_seq'::regclass);


--
-- Name: housekeeping_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_logs ALTER COLUMN id SET DEFAULT nextval('public.housekeeping_logs_id_seq'::regclass);


--
-- Name: housekeeping_request_updates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_request_updates ALTER COLUMN id SET DEFAULT nextval('public.housekeeping_request_updates_id_seq'::regclass);


--
-- Name: housekeeping_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_requests ALTER COLUMN id SET DEFAULT nextval('public.housekeeping_requests_id_seq'::regclass);


--
-- Name: housekeeping_zones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_zones ALTER COLUMN id SET DEFAULT nextval('public.housekeeping_zones_id_seq'::regclass);


--
-- Name: hr_activity_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_activity_logs ALTER COLUMN id SET DEFAULT nextval('public.hr_activity_logs_id_seq'::regclass);


--
-- Name: icd10_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.icd10_codes ALTER COLUMN id SET DEFAULT nextval('public.icd10_codes_id_seq'::regclass);


--
-- Name: immunizations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immunizations ALTER COLUMN id SET DEFAULT nextval('public.immunizations_id_seq'::regclass);


--
-- Name: incident_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports ALTER COLUMN id SET DEFAULT nextval('public.incident_reports_id_seq'::regclass);


--
-- Name: infection_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.infection_cases ALTER COLUMN id SET DEFAULT nextval('public.infection_cases_id_seq'::regclass);


--
-- Name: insurance_claims id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insurance_claims ALTER COLUMN id SET DEFAULT nextval('public.insurance_claims_id_seq'::regclass);


--
-- Name: intake_output id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_output ALTER COLUMN id SET DEFAULT nextval('public.intake_output_id_seq'::regclass);


--
-- Name: investigation_booking_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_booking_history ALTER COLUMN id SET DEFAULT nextval('public.investigation_booking_history_id_seq'::regclass);


--
-- Name: investigation_bookings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_bookings ALTER COLUMN id SET DEFAULT nextval('public.investigation_bookings_id_seq'::regclass);


--
-- Name: investigation_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_files ALTER COLUMN id SET DEFAULT nextval('public.investigation_files_id_seq'::regclass);


--
-- Name: investigation_template_tests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_template_tests ALTER COLUMN id SET DEFAULT nextval('public.investigation_template_tests_id_seq'::regclass);


--
-- Name: investigation_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_templates ALTER COLUMN id SET DEFAULT nextval('public.investigation_templates_id_seq'::regclass);


--
-- Name: investigation_test_catalog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_test_catalog ALTER COLUMN id SET DEFAULT nextval('public.investigation_test_catalog_id_seq'::regclass);


--
-- Name: investigations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigations ALTER COLUMN id SET DEFAULT nextval('public.investigations_id_seq'::regclass);


--
-- Name: investment_declarations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investment_declarations ALTER COLUMN id SET DEFAULT nextval('public.investment_declarations_id_seq'::regclass);


--
-- Name: invoices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices ALTER COLUMN id SET DEFAULT nextval('public.invoices_id_seq'::regclass);


--
-- Name: leave_applications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_applications ALTER COLUMN id SET DEFAULT nextval('public.leave_applications_id_seq'::regclass);


--
-- Name: leave_balance_overrides id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_balance_overrides ALTER COLUMN id SET DEFAULT nextval('public.leave_balance_overrides_id_seq'::regclass);


--
-- Name: leave_encashments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_encashments ALTER COLUMN id SET DEFAULT nextval('public.leave_encashments_id_seq'::regclass);


--
-- Name: leave_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_requests ALTER COLUMN id SET DEFAULT nextval('public.leave_requests_id_seq'::regclass);


--
-- Name: leave_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_types ALTER COLUMN id SET DEFAULT nextval('public.leave_types_id_seq'::regclass);


--
-- Name: legal_holds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_holds ALTER COLUMN id SET DEFAULT nextval('public.legal_holds_id_seq'::regclass);


--
-- Name: medical_activity_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medical_activity_logs ALTER COLUMN id SET DEFAULT nextval('public.medical_activity_logs_id_seq'::regclass);


--
-- Name: medical_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medical_records ALTER COLUMN id SET DEFAULT nextval('public.medical_records_id_seq'::regclass);


--
-- Name: medication_administrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medication_administrations ALTER COLUMN id SET DEFAULT nextval('public.medication_administrations_id_seq'::regclass);


--
-- Name: medication_reminders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medication_reminders ALTER COLUMN id SET DEFAULT nextval('public.medication_reminders_id_seq'::regclass);


--
-- Name: medications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medications ALTER COLUMN id SET DEFAULT nextval('public.medications_id_seq'::regclass);


--
-- Name: notification_delivery_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_delivery_log ALTER COLUMN id SET DEFAULT nextval('public.notification_delivery_log_id_seq'::regclass);


--
-- Name: notification_outbox id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox ALTER COLUMN id SET DEFAULT nextval('public.notification_outbox_id_seq'::regclass);


--
-- Name: notification_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates ALTER COLUMN id SET DEFAULT nextval('public.notification_templates_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: nurse_handovers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nurse_handovers ALTER COLUMN id SET DEFAULT nextval('public.nurse_handovers_id_seq'::regclass);


--
-- Name: onboarding_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_tasks ALTER COLUMN id SET DEFAULT nextval('public.onboarding_tasks_id_seq'::regclass);


--
-- Name: order_sets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_sets ALTER COLUMN id SET DEFAULT nextval('public.order_sets_id_seq'::regclass);


--
-- Name: ot_schedules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ot_schedules ALTER COLUMN id SET DEFAULT nextval('public.ot_schedules_id_seq'::regclass);


--
-- Name: otp_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_codes ALTER COLUMN id SET DEFAULT nextval('public.otp_codes_id_seq'::regclass);


--
-- Name: otp_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_logs ALTER COLUMN id SET DEFAULT nextval('public.otp_logs_id_seq'::regclass);


--
-- Name: otp_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_sessions ALTER COLUMN id SET DEFAULT nextval('public.otp_sessions_id_seq'::regclass);


--
-- Name: overtime_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overtime_requests ALTER COLUMN id SET DEFAULT nextval('public.overtime_requests_id_seq'::regclass);


--
-- Name: password_reset_otps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_otps ALTER COLUMN id SET DEFAULT nextval('public.password_reset_otps_id_seq'::regclass);


--
-- Name: patient_allergies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergies ALTER COLUMN id SET DEFAULT nextval('public.patient_allergies_id_seq'::regclass);


--
-- Name: patient_consents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_consents ALTER COLUMN id SET DEFAULT nextval('public.patient_consents_id_seq'::regclass);


--
-- Name: patient_feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_feedback ALTER COLUMN id SET DEFAULT nextval('public.patient_feedback_id_seq'::regclass);


--
-- Name: patient_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_records ALTER COLUMN id SET DEFAULT nextval('public.patient_records_id_seq'::regclass);


--
-- Name: payment_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions ALTER COLUMN id SET DEFAULT nextval('public.payment_transactions_id_seq'::regclass);


--
-- Name: payroll_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs ALTER COLUMN id SET DEFAULT nextval('public.payroll_runs_id_seq'::regclass);


--
-- Name: payslip_queries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslip_queries ALTER COLUMN id SET DEFAULT nextval('public.payslip_queries_id_seq'::regclass);


--
-- Name: payslip_query_replies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslip_query_replies ALTER COLUMN id SET DEFAULT nextval('public.payslip_query_replies_id_seq'::regclass);


--
-- Name: payslips id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslips ALTER COLUMN id SET DEFAULT nextval('public.payslips_id_seq'::regclass);


--
-- Name: performance_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_reviews ALTER COLUMN id SET DEFAULT nextval('public.performance_reviews_id_seq'::regclass);


--
-- Name: pharmacies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacies ALTER COLUMN id SET DEFAULT nextval('public.pharmacies_id_seq'::regclass);


--
-- Name: pharmacy_activity_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_activity_logs ALTER COLUMN id SET DEFAULT nextval('public.pharmacy_activity_logs_id_seq'::regclass);


--
-- Name: pharmacy_catalog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_catalog ALTER COLUMN id SET DEFAULT nextval('public.pharmacy_catalog_id_seq'::regclass);


--
-- Name: pharmacy_order_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_order_history ALTER COLUMN id SET DEFAULT nextval('public.pharmacy_order_history_id_seq'::regclass);


--
-- Name: pharmacy_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_orders ALTER COLUMN id SET DEFAULT nextval('public.pharmacy_orders_id_seq'::regclass);


--
-- Name: prescriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescriptions ALTER COLUMN id SET DEFAULT nextval('public.prescriptions_id_seq'::regclass);


--
-- Name: quality_incidents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_incidents ALTER COLUMN id SET DEFAULT nextval('public.quality_incidents_id_seq'::regclass);


--
-- Name: quarantined_files id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantined_files ALTER COLUMN id SET DEFAULT nextval('public.quarantined_files_id_seq'::regclass);


--
-- Name: radiology_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.radiology_orders ALTER COLUMN id SET DEFAULT nextval('public.radiology_orders_id_seq'::regclass);


--
-- Name: referrals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals ALTER COLUMN id SET DEFAULT nextval('public.referrals_id_seq'::regclass);


--
-- Name: replacement_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_requests ALTER COLUMN id SET DEFAULT nextval('public.replacement_requests_id_seq'::regclass);


--
-- Name: report_updates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_updates ALTER COLUMN id SET DEFAULT nextval('public.report_updates_id_seq'::regclass);


--
-- Name: salary_advances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_advances ALTER COLUMN id SET DEFAULT nextval('public.salary_advances_id_seq'::regclass);


--
-- Name: salary_arrears id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_arrears ALTER COLUMN id SET DEFAULT nextval('public.salary_arrears_id_seq'::regclass);


--
-- Name: salary_revisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions ALTER COLUMN id SET DEFAULT nextval('public.salary_revisions_id_seq'::regclass);


--
-- Name: scheduled_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_notifications ALTER COLUMN id SET DEFAULT nextval('public.scheduled_notifications_id_seq'::regclass);


--
-- Name: sos_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sos_alerts ALTER COLUMN id SET DEFAULT nextval('public.sos_alerts_id_seq'::regclass);


--
-- Name: sos_services id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sos_services ALTER COLUMN id SET DEFAULT nextval('public.sos_services_id_seq'::regclass);


--
-- Name: staff id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff ALTER COLUMN id SET DEFAULT nextval('public.staff_id_seq'::regclass);


--
-- Name: staff_attendance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_attendance ALTER COLUMN id SET DEFAULT nextval('public.staff_attendance_id_seq'::regclass);


--
-- Name: staff_auth_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_auth_sessions ALTER COLUMN id SET DEFAULT nextval('public.staff_auth_sessions_id_seq'::regclass);


--
-- Name: staff_breaks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_breaks ALTER COLUMN id SET DEFAULT nextval('public.staff_breaks_id_seq'::regclass);


--
-- Name: staff_devices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_devices ALTER COLUMN id SET DEFAULT nextval('public.staff_devices_id_seq'::regclass);


--
-- Name: staff_grievances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_grievances ALTER COLUMN id SET DEFAULT nextval('public.staff_grievances_id_seq'::regclass);


--
-- Name: staff_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_messages ALTER COLUMN id SET DEFAULT nextval('public.staff_messages_id_seq'::regclass);


--
-- Name: staff_onboarding_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_onboarding_tasks ALTER COLUMN id SET DEFAULT nextval('public.staff_onboarding_tasks_id_seq'::regclass);


--
-- Name: staff_performance_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_performance_reviews ALTER COLUMN id SET DEFAULT nextval('public.staff_performance_reviews_id_seq'::regclass);


--
-- Name: staff_salary id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_salary ALTER COLUMN id SET DEFAULT nextval('public.staff_salary_id_seq'::regclass);


--
-- Name: staff_shift_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shift_assignments ALTER COLUMN id SET DEFAULT nextval('public.staff_shift_assignments_id_seq'::regclass);


--
-- Name: staff_shifts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shifts ALTER COLUMN id SET DEFAULT nextval('public.staff_shifts_id_seq'::regclass);


--
-- Name: step_profiles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_profiles ALTER COLUMN id SET DEFAULT nextval('public.step_profiles_id_seq'::regclass);


--
-- Name: step_rewards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_rewards ALTER COLUMN id SET DEFAULT nextval('public.step_rewards_id_seq'::regclass);


--
-- Name: step_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_sessions ALTER COLUMN id SET DEFAULT nextval('public.step_sessions_id_seq'::regclass);


--
-- Name: system_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alerts ALTER COLUMN id SET DEFAULT nextval('public.system_alerts_id_seq'::regclass);


--
-- Name: system_settings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings ALTER COLUMN id SET DEFAULT nextval('public.system_settings_id_seq'::regclass);


--
-- Name: totp_challenges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.totp_challenges ALTER COLUMN id SET DEFAULT nextval('public.totp_challenges_id_seq'::regclass);


--
-- Name: user_action_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_action_logs ALTER COLUMN id SET DEFAULT nextval('public.user_action_logs_id_seq'::regclass);


--
-- Name: user_deactivation_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_deactivation_log ALTER COLUMN id SET DEFAULT nextval('public.user_deactivation_log_id_seq'::regclass);


--
-- Name: user_devices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices ALTER COLUMN id SET DEFAULT nextval('public.user_devices_id_seq'::regclass);


--
-- Name: user_reactivation_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reactivation_log ALTER COLUMN id SET DEFAULT nextval('public.user_reactivation_log_id_seq'::regclass);


--
-- Name: user_role_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_audit ALTER COLUMN id SET DEFAULT nextval('public.user_role_audit_id_seq'::regclass);


--
-- Name: user_roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles ALTER COLUMN id SET DEFAULT nextval('public.user_roles_id_seq'::regclass);


--
-- Name: user_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions ALTER COLUMN id SET DEFAULT nextval('public.user_sessions_id_seq'::regclass);


--
-- Name: user_status_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_status_history ALTER COLUMN id SET DEFAULT nextval('public.user_status_history_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: vital_signs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vital_signs ALTER COLUMN id SET DEFAULT nextval('public.vital_signs_id_seq'::regclass);


--
-- Name: vitals_chart id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vitals_chart ALTER COLUMN id SET DEFAULT nextval('public.vitals_chart_id_seq'::regclass);


--
-- Name: wards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wards ALTER COLUMN id SET DEFAULT nextval('public.wards_id_seq'::regclass);


--
-- Name: abdm_consents abdm_consents_consent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abdm_consents
    ADD CONSTRAINT abdm_consents_consent_id_key UNIQUE (consent_id);


--
-- Name: abdm_consents abdm_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abdm_consents
    ADD CONSTRAINT abdm_consents_pkey PRIMARY KEY (id);


--
-- Name: abdm_data_requests abdm_data_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abdm_data_requests
    ADD CONSTRAINT abdm_data_requests_pkey PRIMARY KEY (id);


--
-- Name: abdm_data_requests abdm_data_requests_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.abdm_data_requests
    ADD CONSTRAINT abdm_data_requests_transaction_id_key UNIQUE (transaction_id);


--
-- Name: admin_actions admin_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_pkey PRIMARY KEY (id);


--
-- Name: admin_activity_logs admin_activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_activity_logs
    ADD CONSTRAINT admin_activity_logs_pkey PRIMARY KEY (id);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (uid);


--
-- Name: admissions admissions_encounter_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admissions
    ADD CONSTRAINT admissions_encounter_id_key UNIQUE (encounter_id);


--
-- Name: admissions admissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admissions
    ADD CONSTRAINT admissions_pkey PRIMARY KEY (id);


--
-- Name: advance_deductions advance_deductions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.advance_deductions
    ADD CONSTRAINT advance_deductions_pkey PRIMARY KEY (id);


--
-- Name: allergies allergies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allergies
    ADD CONSTRAINT allergies_pkey PRIMARY KEY (id);


--
-- Name: annual_review_reminders annual_review_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_review_reminders
    ADD CONSTRAINT annual_review_reminders_pkey PRIMARY KEY (id);


--
-- Name: annual_review_reminders annual_review_reminders_staff_uid_review_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_review_reminders
    ADD CONSTRAINT annual_review_reminders_staff_uid_review_year_key UNIQUE (staff_uid, review_year);


--
-- Name: annual_tax_summaries annual_tax_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_tax_summaries
    ADD CONSTRAINT annual_tax_summaries_pkey PRIMARY KEY (id);


--
-- Name: annual_tax_summaries annual_tax_summaries_staff_uid_financial_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_tax_summaries
    ADD CONSTRAINT annual_tax_summaries_staff_uid_financial_year_key UNIQUE (staff_uid, financial_year);


--
-- Name: anomalies anomalies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anomalies
    ADD CONSTRAINT anomalies_pkey PRIMARY KEY (id);


--
-- Name: api_access_logs api_access_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_access_logs
    ADD CONSTRAINT api_access_logs_pkey PRIMARY KEY (id);


--
-- Name: appointment_archive appointment_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_archive
    ADD CONSTRAINT appointment_archive_pkey PRIMARY KEY (id);


--
-- Name: appointment_documents appointment_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_documents
    ADD CONSTRAINT appointment_documents_pkey PRIMARY KEY (id);


--
-- Name: appointment_status_history appointment_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_status_history
    ADD CONSTRAINT appointment_status_history_pkey PRIMARY KEY (id);


--
-- Name: appointments appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (id);


--
-- Name: attendance_disputes attendance_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_disputes
    ADD CONSTRAINT attendance_disputes_pkey PRIMARY KEY (id);


--
-- Name: attendance_disputes attendance_disputes_staff_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_disputes
    ADD CONSTRAINT attendance_disputes_staff_id_date_key UNIQUE (staff_id, date);


--
-- Name: attendance_logs attendance_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_logs
    ADD CONSTRAINT attendance_logs_pkey PRIMARY KEY (id);


--
-- Name: attendance_regularization attendance_regularization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_regularization
    ADD CONSTRAINT attendance_regularization_pkey PRIMARY KEY (id);


--
-- Name: attendance_regularization attendance_regularization_staff_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_regularization
    ADD CONSTRAINT attendance_regularization_staff_id_date_key UNIQUE (staff_id, date);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: auth_logs auth_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_logs
    ADD CONSTRAINT auth_logs_pkey PRIMARY KEY (id);


--
-- Name: batch_upload_logs batch_upload_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_upload_logs
    ADD CONSTRAINT batch_upload_logs_pkey PRIMARY KEY (id);


--
-- Name: bed_transfers bed_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bed_transfers
    ADD CONSTRAINT bed_transfers_pkey PRIMARY KEY (id);


--
-- Name: beds beds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beds
    ADD CONSTRAINT beds_pkey PRIMARY KEY (id);


--
-- Name: blood_banks blood_banks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blood_banks
    ADD CONSTRAINT blood_banks_pkey PRIMARY KEY (id);


--
-- Name: blood_requests blood_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blood_requests
    ADD CONSTRAINT blood_requests_pkey PRIMARY KEY (id);


--
-- Name: bulk_operation_logs bulk_operation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_operation_logs
    ADD CONSTRAINT bulk_operation_logs_pkey PRIMARY KEY (id);


--
-- Name: bulk_revision_jobs bulk_revision_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_revision_jobs
    ADD CONSTRAINT bulk_revision_jobs_pkey PRIMARY KEY (id);


--
-- Name: canary_checks canary_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canary_checks
    ADD CONSTRAINT canary_checks_pkey PRIMARY KEY (id);


--
-- Name: cds_alerts cds_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cds_alerts
    ADD CONSTRAINT cds_alerts_pkey PRIMARY KEY (id);


--
-- Name: clinical_alerts clinical_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_alerts
    ADD CONSTRAINT clinical_alerts_pkey PRIMARY KEY (id);


--
-- Name: clinical_notes clinical_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_notes
    ADD CONSTRAINT clinical_notes_pkey PRIMARY KEY (id);


--
-- Name: clinical_orders clinical_orders_order_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_orders
    ADD CONSTRAINT clinical_orders_order_number_key UNIQUE (order_number);


--
-- Name: clinical_orders clinical_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_orders
    ADD CONSTRAINT clinical_orders_pkey PRIMARY KEY (id);


--
-- Name: clinical_protocols clinical_protocols_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_protocols
    ADD CONSTRAINT clinical_protocols_pkey PRIMARY KEY (id);


--
-- Name: consultations consultations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consultations
    ADD CONSTRAINT consultations_pkey PRIMARY KEY (id);


--
-- Name: data_breaches data_breaches_breach_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_breaches
    ADD CONSTRAINT data_breaches_breach_id_key UNIQUE (breach_id);


--
-- Name: data_breaches data_breaches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_breaches
    ADD CONSTRAINT data_breaches_pkey PRIMARY KEY (id);


--
-- Name: delivery_location_updates delivery_location_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_location_updates
    ADD CONSTRAINT delivery_location_updates_pkey PRIMARY KEY (id);


--
-- Name: department_audit_log department_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_audit_log
    ADD CONSTRAINT department_audit_log_pkey PRIMARY KEY (id);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: diagnoses diagnoses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diagnoses
    ADD CONSTRAINT diagnoses_pkey PRIMARY KEY (id);


--
-- Name: diet_orders diet_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.diet_orders
    ADD CONSTRAINT diet_orders_pkey PRIMARY KEY (id);


--
-- Name: discharge_summaries discharge_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discharge_summaries
    ADD CONSTRAINT discharge_summaries_pkey PRIMARY KEY (id);


--
-- Name: doctors doctors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_pkey PRIMARY KEY (id);


--
-- Name: drug_interactions drug_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drug_interactions
    ADD CONSTRAINT drug_interactions_pkey PRIMARY KEY (id);


--
-- Name: e_prescriptions e_prescriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e_prescriptions
    ADD CONSTRAINT e_prescriptions_pkey PRIMARY KEY (id);


--
-- Name: e_prescriptions e_prescriptions_prescription_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e_prescriptions
    ADD CONSTRAINT e_prescriptions_prescription_number_key UNIQUE (prescription_number);


--
-- Name: emergency_services emergency_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_services
    ADD CONSTRAINT emergency_services_pkey PRIMARY KEY (id);


--
-- Name: failed_notifications failed_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.failed_notifications
    ADD CONSTRAINT failed_notifications_pkey PRIMARY KEY (id);


--
-- Name: feature_flags feature_flags_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_name_key UNIQUE (name);


--
-- Name: feature_flags feature_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);


--
-- Name: feedback feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);


--
-- Name: feedback_responses feedback_responses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_responses
    ADD CONSTRAINT feedback_responses_pkey PRIMARY KEY (id);


--
-- Name: file_access_logs file_access_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_access_logs
    ADD CONSTRAINT file_access_logs_pkey PRIMARY KEY (id);


--
-- Name: file_deletion_log file_deletion_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_deletion_log
    ADD CONSTRAINT file_deletion_log_pkey PRIMARY KEY (id);


--
-- Name: file_metadata file_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_metadata
    ADD CONSTRAINT file_metadata_pkey PRIMARY KEY (id);


--
-- Name: full_final_settlements full_final_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.full_final_settlements
    ADD CONSTRAINT full_final_settlements_pkey PRIMARY KEY (id);


--
-- Name: gdpr_erasure_log gdpr_erasure_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gdpr_erasure_log
    ADD CONSTRAINT gdpr_erasure_log_pkey PRIMARY KEY (id);


--
-- Name: geofence_breaches geofence_breaches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_breaches
    ADD CONSTRAINT geofence_breaches_pkey PRIMARY KEY (id);


--
-- Name: health_records health_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_records
    ADD CONSTRAINT health_records_pkey PRIMARY KEY (id);


--
-- Name: hipaa_access_log hipaa_access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hipaa_access_log
    ADD CONSTRAINT hipaa_access_log_pkey PRIMARY KEY (id);


--
-- Name: hospitals hospitals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hospitals
    ADD CONSTRAINT hospitals_pkey PRIMARY KEY (id);


--
-- Name: housekeeping_logs housekeeping_logs_log_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_logs
    ADD CONSTRAINT housekeeping_logs_log_number_key UNIQUE (log_number);


--
-- Name: housekeeping_logs housekeeping_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_logs
    ADD CONSTRAINT housekeeping_logs_pkey PRIMARY KEY (id);


--
-- Name: housekeeping_request_updates housekeeping_request_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_request_updates
    ADD CONSTRAINT housekeeping_request_updates_pkey PRIMARY KEY (id);


--
-- Name: housekeeping_requests housekeeping_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_requests
    ADD CONSTRAINT housekeeping_requests_pkey PRIMARY KEY (id);


--
-- Name: housekeeping_requests housekeeping_requests_request_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_requests
    ADD CONSTRAINT housekeeping_requests_request_number_key UNIQUE (request_number);


--
-- Name: housekeeping_zones housekeeping_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_zones
    ADD CONSTRAINT housekeeping_zones_pkey PRIMARY KEY (id);


--
-- Name: hr_activity_logs hr_activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hr_activity_logs
    ADD CONSTRAINT hr_activity_logs_pkey PRIMARY KEY (id);


--
-- Name: icd10_codes icd10_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.icd10_codes
    ADD CONSTRAINT icd10_codes_code_key UNIQUE (code);


--
-- Name: icd10_codes icd10_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.icd10_codes
    ADD CONSTRAINT icd10_codes_pkey PRIMARY KEY (id);


--
-- Name: immunizations immunizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immunizations
    ADD CONSTRAINT immunizations_pkey PRIMARY KEY (id);


--
-- Name: incident_reports incident_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_pkey PRIMARY KEY (id);


--
-- Name: incident_reports incident_reports_report_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_report_number_key UNIQUE (report_number);


--
-- Name: infection_cases infection_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.infection_cases
    ADD CONSTRAINT infection_cases_pkey PRIMARY KEY (id);


--
-- Name: insurance_claims insurance_claims_claim_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insurance_claims
    ADD CONSTRAINT insurance_claims_claim_number_key UNIQUE (claim_number);


--
-- Name: insurance_claims insurance_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insurance_claims
    ADD CONSTRAINT insurance_claims_pkey PRIMARY KEY (id);


--
-- Name: intake_output intake_output_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_output
    ADD CONSTRAINT intake_output_pkey PRIMARY KEY (id);


--
-- Name: invalidated_tokens invalidated_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invalidated_tokens
    ADD CONSTRAINT invalidated_tokens_pkey PRIMARY KEY (jti);


--
-- Name: investigation_booking_history investigation_booking_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_booking_history
    ADD CONSTRAINT investigation_booking_history_pkey PRIMARY KEY (id);


--
-- Name: investigation_bookings investigation_bookings_booking_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_bookings
    ADD CONSTRAINT investigation_bookings_booking_number_key UNIQUE (booking_number);


--
-- Name: investigation_bookings investigation_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_bookings
    ADD CONSTRAINT investigation_bookings_pkey PRIMARY KEY (id);


--
-- Name: investigation_files investigation_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_files
    ADD CONSTRAINT investigation_files_pkey PRIMARY KEY (id);


--
-- Name: investigation_template_tests investigation_template_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_template_tests
    ADD CONSTRAINT investigation_template_tests_pkey PRIMARY KEY (id);


--
-- Name: investigation_templates investigation_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_templates
    ADD CONSTRAINT investigation_templates_pkey PRIMARY KEY (id);


--
-- Name: investigation_test_catalog investigation_test_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_test_catalog
    ADD CONSTRAINT investigation_test_catalog_pkey PRIMARY KEY (id);


--
-- Name: investigations investigations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigations
    ADD CONSTRAINT investigations_pkey PRIMARY KEY (id);


--
-- Name: investment_declarations investment_declarations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investment_declarations
    ADD CONSTRAINT investment_declarations_pkey PRIMARY KEY (id);


--
-- Name: investment_declarations investment_declarations_staff_uid_financial_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investment_declarations
    ADD CONSTRAINT investment_declarations_staff_uid_financial_year_key UNIQUE (staff_uid, financial_year);


--
-- Name: invoices invoices_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: leave_applications leave_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_applications
    ADD CONSTRAINT leave_applications_pkey PRIMARY KEY (id);


--
-- Name: leave_balance_overrides leave_balance_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_balance_overrides
    ADD CONSTRAINT leave_balance_overrides_pkey PRIMARY KEY (id);


--
-- Name: leave_encashments leave_encashments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_encashments
    ADD CONSTRAINT leave_encashments_pkey PRIMARY KEY (id);


--
-- Name: leave_requests leave_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_requests
    ADD CONSTRAINT leave_requests_pkey PRIMARY KEY (id);


--
-- Name: leave_types leave_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_types
    ADD CONSTRAINT leave_types_pkey PRIMARY KEY (id);


--
-- Name: legal_holds legal_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_holds
    ADD CONSTRAINT legal_holds_pkey PRIMARY KEY (id);


--
-- Name: medical_activity_logs medical_activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medical_activity_logs
    ADD CONSTRAINT medical_activity_logs_pkey PRIMARY KEY (id);


--
-- Name: medical_records medical_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medical_records
    ADD CONSTRAINT medical_records_pkey PRIMARY KEY (id);


--
-- Name: medication_administrations medication_administrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medication_administrations
    ADD CONSTRAINT medication_administrations_pkey PRIMARY KEY (id);


--
-- Name: medication_reminders medication_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medication_reminders
    ADD CONSTRAINT medication_reminders_pkey PRIMARY KEY (id);


--
-- Name: medications medications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medications
    ADD CONSTRAINT medications_pkey PRIMARY KEY (id);


--
-- Name: notification_delivery_log notification_delivery_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_delivery_log
    ADD CONSTRAINT notification_delivery_log_pkey PRIMARY KEY (id);


--
-- Name: notification_outbox notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: notification_templates notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: nurse_handovers nurse_handovers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nurse_handovers
    ADD CONSTRAINT nurse_handovers_pkey PRIMARY KEY (id);


--
-- Name: onboarding_tasks onboarding_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_tasks
    ADD CONSTRAINT onboarding_tasks_pkey PRIMARY KEY (id);


--
-- Name: order_sets order_sets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_sets
    ADD CONSTRAINT order_sets_pkey PRIMARY KEY (id);


--
-- Name: ot_schedules ot_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ot_schedules
    ADD CONSTRAINT ot_schedules_pkey PRIMARY KEY (id);


--
-- Name: otp_codes otp_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_codes
    ADD CONSTRAINT otp_codes_pkey PRIMARY KEY (id);


--
-- Name: otp_logs otp_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_logs
    ADD CONSTRAINT otp_logs_pkey PRIMARY KEY (id);


--
-- Name: otp_sessions otp_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.otp_sessions
    ADD CONSTRAINT otp_sessions_pkey PRIMARY KEY (id);


--
-- Name: overtime_requests overtime_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overtime_requests
    ADD CONSTRAINT overtime_requests_pkey PRIMARY KEY (id);


--
-- Name: password_reset_otps password_reset_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_otps
    ADD CONSTRAINT password_reset_otps_pkey PRIMARY KEY (id);


--
-- Name: patient_allergies patient_allergies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_allergies
    ADD CONSTRAINT patient_allergies_pkey PRIMARY KEY (id);


--
-- Name: patient_consents patient_consents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_consents
    ADD CONSTRAINT patient_consents_pkey PRIMARY KEY (id);


--
-- Name: patient_feedback patient_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_feedback
    ADD CONSTRAINT patient_feedback_pkey PRIMARY KEY (id);


--
-- Name: patient_records patient_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_records
    ADD CONSTRAINT patient_records_pkey PRIMARY KEY (id);


--
-- Name: payment_transactions payment_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT payment_transactions_pkey PRIMARY KEY (id);


--
-- Name: payroll_runs payroll_runs_month_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_month_year_key UNIQUE (month, year);


--
-- Name: payroll_runs payroll_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_pkey PRIMARY KEY (id);


--
-- Name: payslip_queries payslip_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslip_queries
    ADD CONSTRAINT payslip_queries_pkey PRIMARY KEY (id);


--
-- Name: payslip_query_replies payslip_query_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslip_query_replies
    ADD CONSTRAINT payslip_query_replies_pkey PRIMARY KEY (id);


--
-- Name: payslips payslips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_pkey PRIMARY KEY (id);


--
-- Name: payslips payslips_staff_uid_month_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_staff_uid_month_year_key UNIQUE (staff_uid, month, year);


--
-- Name: performance_reviews performance_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.performance_reviews
    ADD CONSTRAINT performance_reviews_pkey PRIMARY KEY (id);


--
-- Name: pharmacies pharmacies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacies
    ADD CONSTRAINT pharmacies_pkey PRIMARY KEY (id);


--
-- Name: pharmacy_activity_logs pharmacy_activity_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_activity_logs
    ADD CONSTRAINT pharmacy_activity_logs_pkey PRIMARY KEY (id);


--
-- Name: pharmacy_catalog pharmacy_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_catalog
    ADD CONSTRAINT pharmacy_catalog_pkey PRIMARY KEY (id);


--
-- Name: pharmacy_order_history pharmacy_order_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_order_history
    ADD CONSTRAINT pharmacy_order_history_pkey PRIMARY KEY (id);


--
-- Name: pharmacy_orders pharmacy_orders_order_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_orders
    ADD CONSTRAINT pharmacy_orders_order_number_key UNIQUE (order_number);


--
-- Name: pharmacy_orders pharmacy_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_orders
    ADD CONSTRAINT pharmacy_orders_pkey PRIMARY KEY (id);


--
-- Name: prescriptions prescriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prescriptions
    ADD CONSTRAINT prescriptions_pkey PRIMARY KEY (id);


--
-- Name: quality_incidents quality_incidents_incident_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_incidents
    ADD CONSTRAINT quality_incidents_incident_number_key UNIQUE (incident_number);


--
-- Name: quality_incidents quality_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_incidents
    ADD CONSTRAINT quality_incidents_pkey PRIMARY KEY (id);


--
-- Name: quarantined_files quarantined_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantined_files
    ADD CONSTRAINT quarantined_files_pkey PRIMARY KEY (id);


--
-- Name: radiology_orders radiology_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.radiology_orders
    ADD CONSTRAINT radiology_orders_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_referral_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referral_number_key UNIQUE (referral_number);


--
-- Name: replacement_requests replacement_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_requests
    ADD CONSTRAINT replacement_requests_pkey PRIMARY KEY (id);


--
-- Name: report_updates report_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_updates
    ADD CONSTRAINT report_updates_pkey PRIMARY KEY (id);


--
-- Name: salary_advances salary_advances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_advances
    ADD CONSTRAINT salary_advances_pkey PRIMARY KEY (id);


--
-- Name: salary_arrears salary_arrears_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_arrears
    ADD CONSTRAINT salary_arrears_pkey PRIMARY KEY (id);


--
-- Name: salary_revisions salary_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_pkey PRIMARY KEY (id);


--
-- Name: salary_revisions salary_revisions_revision_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_revision_number_key UNIQUE (revision_number);


--
-- Name: scheduled_notifications scheduled_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_notifications
    ADD CONSTRAINT scheduled_notifications_pkey PRIMARY KEY (id);


--
-- Name: sos_alerts sos_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sos_alerts
    ADD CONSTRAINT sos_alerts_pkey PRIMARY KEY (id);


--
-- Name: sos_services sos_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sos_services
    ADD CONSTRAINT sos_services_pkey PRIMARY KEY (id);


--
-- Name: staff_attendance staff_attendance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_attendance
    ADD CONSTRAINT staff_attendance_pkey PRIMARY KEY (id);


--
-- Name: staff_auth_sessions staff_auth_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_auth_sessions
    ADD CONSTRAINT staff_auth_sessions_pkey PRIMARY KEY (id);


--
-- Name: staff_breaks staff_breaks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_breaks
    ADD CONSTRAINT staff_breaks_pkey PRIMARY KEY (id);


--
-- Name: staff_devices staff_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_devices
    ADD CONSTRAINT staff_devices_pkey PRIMARY KEY (id);


--
-- Name: staff_grievances staff_grievances_grievance_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_grievances
    ADD CONSTRAINT staff_grievances_grievance_number_key UNIQUE (grievance_number);


--
-- Name: staff_grievances staff_grievances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_grievances
    ADD CONSTRAINT staff_grievances_pkey PRIMARY KEY (id);


--
-- Name: staff_messages staff_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_messages
    ADD CONSTRAINT staff_messages_pkey PRIMARY KEY (id);


--
-- Name: staff_onboarding_tasks staff_onboarding_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_onboarding_tasks
    ADD CONSTRAINT staff_onboarding_tasks_pkey PRIMARY KEY (id);


--
-- Name: staff_performance_reviews staff_performance_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_performance_reviews
    ADD CONSTRAINT staff_performance_reviews_pkey PRIMARY KEY (id);


--
-- Name: staff staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff
    ADD CONSTRAINT staff_pkey PRIMARY KEY (id);


--
-- Name: staff_salary staff_salary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_salary
    ADD CONSTRAINT staff_salary_pkey PRIMARY KEY (id);


--
-- Name: staff_salary staff_salary_staff_uid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_salary
    ADD CONSTRAINT staff_salary_staff_uid_key UNIQUE (staff_uid);


--
-- Name: staff_shift_assignments staff_shift_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shift_assignments
    ADD CONSTRAINT staff_shift_assignments_pkey PRIMARY KEY (id);


--
-- Name: staff_shift_assignments staff_shift_assignments_staff_id_effective_from_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shift_assignments
    ADD CONSTRAINT staff_shift_assignments_staff_id_effective_from_key UNIQUE (staff_id, effective_from);


--
-- Name: staff_shifts staff_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shifts
    ADD CONSTRAINT staff_shifts_pkey PRIMARY KEY (id);


--
-- Name: step_profiles step_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_profiles
    ADD CONSTRAINT step_profiles_pkey PRIMARY KEY (id);


--
-- Name: step_rewards step_rewards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_rewards
    ADD CONSTRAINT step_rewards_pkey PRIMARY KEY (id);


--
-- Name: step_sessions step_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.step_sessions
    ADD CONSTRAINT step_sessions_pkey PRIMARY KEY (id);


--
-- Name: system_alerts system_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_alerts
    ADD CONSTRAINT system_alerts_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_key_key UNIQUE (key);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);


--
-- Name: totp_challenges totp_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.totp_challenges
    ADD CONSTRAINT totp_challenges_pkey PRIMARY KEY (id);


--
-- Name: user_action_logs user_action_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_action_logs
    ADD CONSTRAINT user_action_logs_pkey PRIMARY KEY (id);


--
-- Name: user_deactivation_log user_deactivation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_deactivation_log
    ADD CONSTRAINT user_deactivation_log_pkey PRIMARY KEY (id);


--
-- Name: user_devices user_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT user_devices_pkey PRIMARY KEY (id);


--
-- Name: user_reactivation_log user_reactivation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_reactivation_log
    ADD CONSTRAINT user_reactivation_log_pkey PRIMARY KEY (id);


--
-- Name: user_role_audit user_role_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_role_audit
    ADD CONSTRAINT user_role_audit_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_role_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_name_key UNIQUE (role_name);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_status_history user_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_status_history
    ADD CONSTRAINT user_status_history_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: vital_signs vital_signs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vital_signs
    ADD CONSTRAINT vital_signs_pkey PRIMARY KEY (id);


--
-- Name: vitals_chart vitals_chart_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vitals_chart
    ADD CONSTRAINT vitals_chart_pkey PRIMARY KEY (id);


--
-- Name: wards wards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wards
    ADD CONSTRAINT wards_pkey PRIMARY KEY (id);


--
-- Name: admin_activity_logs_admin_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_activity_logs_admin_uid_idx ON public.admin_activity_logs USING btree (admin_uid);


--
-- Name: admin_activity_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_activity_logs_created_at_idx ON public.admin_activity_logs USING btree (created_at);


--
-- Name: admins_username_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admins_username_idx ON public.admins USING btree (username);


--
-- Name: admins_username_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admins_username_key ON public.admins USING btree (username);


--
-- Name: anomalies_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX anomalies_staff_id_idx ON public.anomalies USING btree (staff_id);


--
-- Name: api_access_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_access_logs_created_at_idx ON public.api_access_logs USING btree (created_at);


--
-- Name: api_access_logs_endpoint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_access_logs_endpoint_idx ON public.api_access_logs USING btree (endpoint);


--
-- Name: appointments_appointment_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_appointment_date_idx ON public.appointments USING btree (appointment_date);


--
-- Name: appointments_doctor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_doctor_id_idx ON public.appointments USING btree (doctor_id);


--
-- Name: appointments_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_phone_idx ON public.appointments USING btree (phone);


--
-- Name: appointments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_status_idx ON public.appointments USING btree (status);


--
-- Name: appointments_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appointments_uid_idx ON public.appointments USING btree (uid);


--
-- Name: attendance_logs_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attendance_logs_staff_id_idx ON public.attendance_logs USING btree (staff_id);


--
-- Name: audit_logs_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_action_idx ON public.audit_logs USING btree (action);


--
-- Name: audit_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_created_at_idx ON public.audit_logs USING btree (created_at);


--
-- Name: audit_logs_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_resource_idx ON public.audit_logs USING btree (resource);


--
-- Name: audit_logs_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_uid_idx ON public.audit_logs USING btree (uid);


--
-- Name: auth_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_logs_created_at_idx ON public.auth_logs USING btree (created_at);


--
-- Name: auth_logs_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_logs_phone_idx ON public.auth_logs USING btree (phone);


--
-- Name: auth_logs_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_logs_user_id_idx ON public.auth_logs USING btree (user_id);


--
-- Name: batch_upload_logs_uploaded_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX batch_upload_logs_uploaded_by_idx ON public.batch_upload_logs USING btree (uploaded_by);


--
-- Name: blood_banks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX blood_banks_status_idx ON public.blood_banks USING btree (status);


--
-- Name: bulk_operation_logs_operation_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bulk_operation_logs_operation_type_idx ON public.bulk_operation_logs USING btree (operation_type);


--
-- Name: consultations_consulted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consultations_consulted_at_idx ON public.consultations USING btree (consulted_at);


--
-- Name: consultations_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consultations_phone_idx ON public.consultations USING btree (phone);


--
-- Name: consultations_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consultations_uid_idx ON public.consultations USING btree (uid);


--
-- Name: department_audit_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX department_audit_log_created_at_idx ON public.department_audit_log USING btree (created_at);


--
-- Name: department_audit_log_department_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX department_audit_log_department_id_idx ON public.department_audit_log USING btree (department_id);


--
-- Name: departments_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX departments_name_key ON public.departments USING btree (name);


--
-- Name: devices_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_device_id_idx ON public.devices USING btree (device_id);


--
-- Name: devices_device_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX devices_device_id_key ON public.devices USING btree (device_id);


--
-- Name: devices_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_is_active_idx ON public.devices USING btree (is_active);


--
-- Name: devices_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_phone_idx ON public.devices USING btree (phone);


--
-- Name: devices_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_uid_idx ON public.devices USING btree (uid);


--
-- Name: doctors_department_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doctors_department_id_idx ON public.doctors USING btree (department_id);


--
-- Name: doctors_is_available_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doctors_is_available_idx ON public.doctors USING btree (is_available);


--
-- Name: feedback_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_category_idx ON public.feedback USING btree (category);


--
-- Name: feedback_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_phone_idx ON public.feedback USING btree (phone);


--
-- Name: feedback_rating_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_rating_idx ON public.feedback USING btree (rating);


--
-- Name: feedback_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_status_idx ON public.feedback USING btree (status);


--
-- Name: feedback_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_uid_idx ON public.feedback USING btree (uid);


--
-- Name: file_access_logs_file_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_access_logs_file_id_idx ON public.file_access_logs USING btree (file_id);


--
-- Name: file_access_logs_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_access_logs_user_id_idx ON public.file_access_logs USING btree (user_id);


--
-- Name: file_deletion_log_deleted_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_deletion_log_deleted_by_idx ON public.file_deletion_log USING btree (deleted_by);


--
-- Name: file_metadata_privacy_level_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_metadata_privacy_level_idx ON public.file_metadata USING btree (privacy_level);


--
-- Name: file_metadata_scan_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_metadata_scan_status_idx ON public.file_metadata USING btree (scan_status);


--
-- Name: file_metadata_storage_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX file_metadata_storage_key_key ON public.file_metadata USING btree (storage_key);


--
-- Name: file_metadata_uploaded_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_metadata_uploaded_at_idx ON public.file_metadata USING btree (uploaded_at);


--
-- Name: file_metadata_uploaded_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_metadata_uploaded_by_idx ON public.file_metadata USING btree (uploaded_by);


--
-- Name: health_records_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX health_records_phone_idx ON public.health_records USING btree (phone);


--
-- Name: health_records_privacy_level_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX health_records_privacy_level_idx ON public.health_records USING btree (privacy_level);


--
-- Name: health_records_record_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX health_records_record_type_idx ON public.health_records USING btree (record_type);


--
-- Name: health_records_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX health_records_uid_idx ON public.health_records USING btree (uid);


--
-- Name: hospitals_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hospitals_status_idx ON public.hospitals USING btree (status);


--
-- Name: hr_activity_logs_hr_staff_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hr_activity_logs_hr_staff_uid_idx ON public.hr_activity_logs USING btree (hr_staff_uid);


--
-- Name: idx_abdm_consents_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_abdm_consents_patient_uid ON public.abdm_consents USING btree (patient_uid);


--
-- Name: idx_abdm_consents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_abdm_consents_status ON public.abdm_consents USING btree (status);


--
-- Name: idx_abdm_data_requests_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_abdm_data_requests_patient ON public.abdm_data_requests USING btree (patient_uid);


--
-- Name: idx_abdm_data_requests_transaction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_abdm_data_requests_transaction ON public.abdm_data_requests USING btree (transaction_id);


--
-- Name: idx_admin_actions_admin_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_actions_admin_uid ON public.admin_actions USING btree (admin_uid);


--
-- Name: idx_admin_actions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_actions_created_at ON public.admin_actions USING btree (created_at);


--
-- Name: idx_admin_actions_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_actions_target ON public.admin_actions USING btree (target_type, target_id);


--
-- Name: idx_admins_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admins_status ON public.admins USING btree (status);


--
-- Name: idx_admissions_admitted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admissions_admitted_at ON public.admissions USING btree (admitted_at);


--
-- Name: idx_admissions_encounter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admissions_encounter_id ON public.admissions USING btree (encounter_id);


--
-- Name: idx_admissions_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admissions_patient_uid ON public.admissions USING btree (patient_uid);


--
-- Name: idx_admissions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admissions_status ON public.admissions USING btree (status);


--
-- Name: idx_advances_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_advances_staff ON public.salary_advances USING btree (staff_uid);


--
-- Name: idx_allergies_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_allergies_patient_uid ON public.allergies USING btree (patient_uid);


--
-- Name: idx_appointment_archive_original_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointment_archive_original_id ON public.appointment_archive USING btree (original_id);


--
-- Name: idx_appointment_archive_patient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointment_archive_patient_id ON public.appointment_archive USING btree (patient_id);


--
-- Name: idx_appointments_patient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointments_patient_id ON public.appointments USING btree (patient_id);


--
-- Name: idx_appointments_reminder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointments_reminder ON public.appointments USING btree (status, appointment_date, reminder_24h_sent);


--
-- Name: idx_appointments_status_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appointments_status_date ON public.appointments USING btree (status, appointment_date DESC);


--
-- Name: idx_appt_confirmed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appt_confirmed_at ON public.appointments USING btree (confirmed_at);


--
-- Name: idx_appt_date_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appt_date_status ON public.appointments USING btree (appointment_date, status);


--
-- Name: idx_appt_docs_appointment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appt_docs_appointment ON public.appointment_documents USING btree (appointment_id);


--
-- Name: idx_appt_docs_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appt_docs_patient ON public.appointment_documents USING btree (patient_id);


--
-- Name: idx_appt_status_hist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_appt_status_hist ON public.appointment_status_history USING btree (appointment_id);


--
-- Name: idx_arrears_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arrears_staff ON public.salary_arrears USING btree (staff_uid);


--
-- Name: idx_attendance_disputes_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_attendance_disputes_staff_id ON public.attendance_disputes USING btree (staff_id);


--
-- Name: idx_audit_logs_uid_action_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_uid_action_time ON public.audit_logs USING btree (uid, action, created_at DESC);


--
-- Name: idx_audit_method; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_method ON public.audit_log USING btree (method);


--
-- Name: idx_audit_module; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_module ON public.audit_log USING btree (module);


--
-- Name: idx_audit_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_status ON public.audit_log USING btree (status_code);


--
-- Name: idx_audit_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_ts ON public.audit_log USING btree (created_at DESC);


--
-- Name: idx_audit_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_user ON public.audit_log USING btree (user_id);


--
-- Name: idx_bed_transfers_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bed_transfers_patient_uid ON public.bed_transfers USING btree (patient_uid);


--
-- Name: idx_bed_transfers_transferred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bed_transfers_transferred_at ON public.bed_transfers USING btree (transferred_at);


--
-- Name: idx_beds_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beds_patient_uid ON public.beds USING btree (patient_uid);


--
-- Name: idx_beds_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beds_status ON public.beds USING btree (status);


--
-- Name: idx_beds_ward_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beds_ward_id ON public.beds USING btree (ward_id);


--
-- Name: idx_blood_requests_blood_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blood_requests_blood_group ON public.blood_requests USING btree (blood_group);


--
-- Name: idx_blood_requests_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blood_requests_patient_uid ON public.blood_requests USING btree (patient_uid);


--
-- Name: idx_blood_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blood_requests_status ON public.blood_requests USING btree (status);


--
-- Name: idx_bulk_rev; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bulk_rev ON public.bulk_revision_jobs USING btree (status);


--
-- Name: idx_canary_checks_checked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canary_checks_checked_at ON public.canary_checks USING btree (checked_at DESC);


--
-- Name: idx_cds_alerts_acknowledged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cds_alerts_acknowledged ON public.cds_alerts USING btree (acknowledged);


--
-- Name: idx_cds_alerts_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cds_alerts_patient_uid ON public.cds_alerts USING btree (patient_uid);


--
-- Name: idx_cds_alerts_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cds_alerts_severity ON public.cds_alerts USING btree (severity);


--
-- Name: idx_clinical_alerts_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_alerts_patient ON public.clinical_alerts USING btree (patient_id, created_at DESC);


--
-- Name: idx_clinical_alerts_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_alerts_severity ON public.clinical_alerts USING btree (severity, acknowledged);


--
-- Name: idx_clinical_notes_author_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_notes_author_uid ON public.clinical_notes USING btree (author_uid);


--
-- Name: idx_clinical_notes_encounter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_notes_encounter_id ON public.clinical_notes USING btree (encounter_id);


--
-- Name: idx_clinical_notes_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_notes_patient_uid ON public.clinical_notes USING btree (patient_uid);


--
-- Name: idx_clinical_notes_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_notes_type ON public.clinical_notes USING btree (note_type);


--
-- Name: idx_clinical_orders_encounter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_orders_encounter_id ON public.clinical_orders USING btree (encounter_id);


--
-- Name: idx_clinical_orders_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_orders_patient_uid ON public.clinical_orders USING btree (patient_uid);


--
-- Name: idx_clinical_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_orders_status ON public.clinical_orders USING btree (status);


--
-- Name: idx_clinical_orders_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_orders_type ON public.clinical_orders USING btree (order_type);


--
-- Name: idx_clinical_protocols_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clinical_protocols_category ON public.clinical_protocols USING btree (category);


--
-- Name: idx_data_breaches_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_data_breaches_severity ON public.data_breaches USING btree (severity);


--
-- Name: idx_data_breaches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_data_breaches_status ON public.data_breaches USING btree (status);


--
-- Name: idx_declarations_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_declarations_staff ON public.investment_declarations USING btree (staff_uid, financial_year);


--
-- Name: idx_delivery_loc_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_loc_order ON public.delivery_location_updates USING btree (order_type, order_id);


--
-- Name: idx_delivery_loc_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_loc_time ON public.delivery_location_updates USING btree (created_at);


--
-- Name: idx_diagnoses_encounter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnoses_encounter_id ON public.diagnoses USING btree (encounter_id);


--
-- Name: idx_diagnoses_icd10; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnoses_icd10 ON public.diagnoses USING btree (icd10_code);


--
-- Name: idx_diagnoses_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnoses_patient_uid ON public.diagnoses USING btree (patient_uid);


--
-- Name: idx_diagnoses_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diagnoses_status ON public.diagnoses USING btree (status);


--
-- Name: idx_diet_orders_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diet_orders_patient_uid ON public.diet_orders USING btree (patient_uid);


--
-- Name: idx_diet_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_diet_orders_status ON public.diet_orders USING btree (status);


--
-- Name: idx_discharge_summaries_encounter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discharge_summaries_encounter ON public.discharge_summaries USING btree (encounter_id);


--
-- Name: idx_discharge_summaries_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discharge_summaries_patient_uid ON public.discharge_summaries USING btree (patient_uid);


--
-- Name: idx_drug_interactions_drug_a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drug_interactions_drug_a ON public.drug_interactions USING btree (drug_a);


--
-- Name: idx_drug_interactions_drug_b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drug_interactions_drug_b ON public.drug_interactions USING btree (drug_b);


--
-- Name: idx_drug_interactions_pair; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_drug_interactions_pair ON public.drug_interactions USING btree (LEAST(drug_a, drug_b), GREATEST(drug_a, drug_b));


--
-- Name: idx_emergency_services_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emergency_services_name ON public.emergency_services USING btree (name);


--
-- Name: idx_eprescription_appointment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eprescription_appointment ON public.e_prescriptions USING btree (appointment_id);


--
-- Name: idx_eprescription_doctor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eprescription_doctor ON public.e_prescriptions USING btree (doctor_id);


--
-- Name: idx_eprescription_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_eprescription_patient ON public.e_prescriptions USING btree (patient_id);


--
-- Name: idx_failed_notifications_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_failed_notifications_status ON public.failed_notifications USING btree (status, next_retry_at);


--
-- Name: idx_failed_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_failed_notifications_user ON public.failed_notifications USING btree (user_id);


--
-- Name: idx_feature_flags_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feature_flags_name ON public.feature_flags USING btree (name);


--
-- Name: idx_feedback_responses_feedback_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feedback_responses_feedback_id ON public.feedback_responses USING btree (feedback_id);


--
-- Name: idx_fnf_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_fnf_staff ON public.full_final_settlements USING btree (staff_uid);


--
-- Name: idx_gdpr_erasure_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gdpr_erasure_created_at ON public.gdpr_erasure_log USING btree (created_at);


--
-- Name: idx_gdpr_erasure_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gdpr_erasure_uid ON public.gdpr_erasure_log USING btree (uid);


--
-- Name: idx_geofence_breaches_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_geofence_breaches_staff_id ON public.geofence_breaches USING btree (staff_id);


--
-- Name: idx_grievance_reporter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grievance_reporter ON public.staff_grievances USING btree (reporter_id);


--
-- Name: idx_grievance_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_grievance_status ON public.staff_grievances USING btree (status);


--
-- Name: idx_hipaa_log_accessed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hipaa_log_accessed_at ON public.hipaa_access_log USING btree (accessed_at);


--
-- Name: idx_hipaa_log_accessed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hipaa_log_accessed_by ON public.hipaa_access_log USING btree (accessed_by);


--
-- Name: idx_hipaa_log_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hipaa_log_patient ON public.hipaa_access_log USING btree (patient_id);


--
-- Name: idx_hk_logs_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_logs_staff ON public.housekeeping_logs USING btree (staff_id);


--
-- Name: idx_hk_logs_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_logs_ts ON public.housekeeping_logs USING btree (logged_at DESC);


--
-- Name: idx_hk_logs_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_logs_zone ON public.housekeeping_logs USING btree (zone_id);


--
-- Name: idx_hk_req_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_req_assigned ON public.housekeeping_requests USING btree (assigned_to);


--
-- Name: idx_hk_req_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_req_status ON public.housekeeping_requests USING btree (status);


--
-- Name: idx_hk_req_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hk_req_ts ON public.housekeeping_requests USING btree (created_at DESC);


--
-- Name: idx_icd10_codes_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_icd10_codes_code ON public.icd10_codes USING btree (code);


--
-- Name: idx_immunizations_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_immunizations_patient_uid ON public.immunizations USING btree (patient_uid);


--
-- Name: idx_incident_reporter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incident_reporter ON public.incident_reports USING btree (reporter_id);


--
-- Name: idx_incident_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incident_severity ON public.incident_reports USING btree (severity);


--
-- Name: idx_incident_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_incident_status ON public.incident_reports USING btree (status);


--
-- Name: idx_infection_cases_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_infection_cases_patient_uid ON public.infection_cases USING btree (patient_uid);


--
-- Name: idx_infection_cases_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_infection_cases_status ON public.infection_cases USING btree (status);


--
-- Name: idx_intake_output_encounter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intake_output_encounter ON public.intake_output USING btree (encounter_id);


--
-- Name: idx_intake_output_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intake_output_patient_uid ON public.intake_output USING btree (patient_uid);


--
-- Name: idx_intake_output_recorded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intake_output_recorded_at ON public.intake_output USING btree (recorded_at);


--
-- Name: idx_inv_booking_hist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_booking_hist ON public.investigation_booking_history USING btree (booking_id);


--
-- Name: idx_inv_bookings_collector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_bookings_collector ON public.investigation_bookings USING btree (assigned_collector);


--
-- Name: idx_inv_bookings_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_bookings_patient ON public.investigation_bookings USING btree (patient_id);


--
-- Name: idx_inv_bookings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_bookings_status ON public.investigation_bookings USING btree (status);


--
-- Name: idx_inv_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_priority ON public.investigations USING btree (priority);


--
-- Name: idx_inv_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inv_status ON public.investigations USING btree (status);


--
-- Name: idx_invalidated_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invalidated_tokens_expires_at ON public.invalidated_tokens USING btree (expires_at);


--
-- Name: idx_investigation_bookings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_investigation_bookings_status ON public.investigation_bookings USING btree (status, created_at);


--
-- Name: idx_investigations_notified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_investigations_notified ON public.investigations USING btree (notified) WHERE (notified = false);


--
-- Name: idx_investigations_patient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_investigations_patient_id ON public.investigations USING btree (patient_id);


--
-- Name: idx_leave_requests_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_requests_created_at ON public.leave_requests USING btree (created_at);


--
-- Name: idx_leave_requests_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_requests_staff_id ON public.leave_requests USING btree (staff_id);


--
-- Name: idx_leave_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leave_requests_status ON public.leave_requests USING btree (status);


--
-- Name: idx_legal_holds_released_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_holds_released_at ON public.legal_holds USING btree (released_at);


--
-- Name: idx_legal_holds_user_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_legal_holds_user_uid ON public.legal_holds USING btree (user_uid);


--
-- Name: idx_med_admin_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_med_admin_patient_uid ON public.medication_administrations USING btree (patient_uid);


--
-- Name: idx_med_admin_scheduled_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_med_admin_scheduled_time ON public.medication_administrations USING btree (scheduled_time);


--
-- Name: idx_med_admin_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_med_admin_status ON public.medication_administrations USING btree (status);


--
-- Name: idx_med_reminders_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_med_reminders_active ON public.medication_reminders USING btree (patient_uid, is_active);


--
-- Name: idx_med_reminders_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_med_reminders_patient_uid ON public.medication_reminders USING btree (patient_uid);


--
-- Name: idx_notification_outbox_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_outbox_recipient ON public.notification_outbox USING btree (recipient_id);


--
-- Name: idx_notification_outbox_retry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_outbox_retry ON public.notification_outbox USING btree (status, retry_count, last_attempt_at);


--
-- Name: idx_notification_outbox_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_outbox_status ON public.notification_outbox USING btree (status, created_at);


--
-- Name: idx_notifications_phone_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_phone_created ON public.notifications USING btree (phone, created_at DESC);


--
-- Name: idx_nurse_handovers_incoming_nurse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nurse_handovers_incoming_nurse ON public.nurse_handovers USING btree (incoming_nurse);


--
-- Name: idx_nurse_handovers_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nurse_handovers_patient_uid ON public.nurse_handovers USING btree (patient_uid);


--
-- Name: idx_nurse_handovers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nurse_handovers_status ON public.nurse_handovers USING btree (status);


--
-- Name: idx_onboarding_tasks_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_onboarding_tasks_staff_id ON public.onboarding_tasks USING btree (staff_id);


--
-- Name: idx_order_sets_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_sets_active ON public.order_sets USING btree (is_active);


--
-- Name: idx_order_sets_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_sets_category ON public.order_sets USING btree (category);


--
-- Name: idx_ot_schedules_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ot_schedules_patient_uid ON public.ot_schedules USING btree (patient_uid);


--
-- Name: idx_ot_schedules_scheduled_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ot_schedules_scheduled_date ON public.ot_schedules USING btree (scheduled_date);


--
-- Name: idx_ot_schedules_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ot_schedules_status ON public.ot_schedules USING btree (status);


--
-- Name: idx_ot_schedules_surgeon; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ot_schedules_surgeon ON public.ot_schedules USING btree (surgeon);


--
-- Name: idx_otp_codes_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otp_codes_expires_at ON public.otp_codes USING btree (expires_at);


--
-- Name: idx_otp_codes_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_otp_codes_phone ON public.otp_codes USING btree (phone);


--
-- Name: idx_overtime_requests_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_overtime_requests_staff_id ON public.overtime_requests USING btree (staff_id);


--
-- Name: idx_patient_allergies_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_allergies_active ON public.patient_allergies USING btree (patient_id, is_active);


--
-- Name: idx_patient_allergies_patient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_allergies_patient_id ON public.patient_allergies USING btree (patient_id);


--
-- Name: idx_patient_allergies_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_allergies_patient_uid ON public.patient_allergies USING btree (patient_uid);


--
-- Name: idx_patient_consents_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_consents_patient_uid ON public.patient_consents USING btree (patient_uid);


--
-- Name: idx_patient_consents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_consents_status ON public.patient_consents USING btree (status);


--
-- Name: idx_patient_consents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_consents_type ON public.patient_consents USING btree (consent_type);


--
-- Name: idx_patient_records_patient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patient_records_patient ON public.patient_records USING btree (patient_id);


--
-- Name: idx_payroll_runs; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payroll_runs ON public.payroll_runs USING btree (month, year);


--
-- Name: idx_payslips_month; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payslips_month ON public.payslips USING btree (month, year);


--
-- Name: idx_payslips_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payslips_staff ON public.payslips USING btree (staff_uid);


--
-- Name: idx_performance_reviews_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_performance_reviews_staff_id ON public.performance_reviews USING btree (staff_id);


--
-- Name: idx_performance_reviews_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_performance_reviews_status ON public.performance_reviews USING btree (status);


--
-- Name: idx_pharm_catalog_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pharm_catalog_cat ON public.pharmacy_catalog USING btree (category);


--
-- Name: idx_pharm_order_hist; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pharm_order_hist ON public.pharmacy_order_history USING btree (order_id);


--
-- Name: idx_pharm_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pharm_orders_status ON public.pharmacy_orders USING btree (status);


--
-- Name: idx_pharmacy_catalog_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pharmacy_catalog_name ON public.pharmacy_catalog USING btree (name);


--
-- Name: idx_pharmacy_orders_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pharmacy_orders_created_at ON public.pharmacy_orders USING btree (created_at DESC);


--
-- Name: idx_pharmacy_orders_patient_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pharmacy_orders_patient_id ON public.pharmacy_orders USING btree (patient_id);


--
-- Name: idx_pharmacy_orders_payment_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pharmacy_orders_payment_status ON public.pharmacy_orders USING btree (payment_status);


--
-- Name: idx_pharmacy_orders_status_ordered; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pharmacy_orders_status_ordered ON public.pharmacy_orders USING btree (status, ordered_at);


--
-- Name: idx_pq_payslip; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pq_payslip ON public.payslip_queries USING btree (payslip_id);


--
-- Name: idx_pq_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pq_staff ON public.payslip_queries USING btree (staff_uid);


--
-- Name: idx_prescriptions_issued_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prescriptions_issued_at ON public.prescriptions USING btree (issued_at);


--
-- Name: idx_prescriptions_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prescriptions_patient_uid ON public.prescriptions USING btree (patient_uid);


--
-- Name: idx_prescriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prescriptions_status ON public.prescriptions USING btree (status);


--
-- Name: idx_quality_incidents_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quality_incidents_date ON public.quality_incidents USING btree (date_occurred);


--
-- Name: idx_quality_incidents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quality_incidents_status ON public.quality_incidents USING btree (status);


--
-- Name: idx_quality_incidents_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quality_incidents_type ON public.quality_incidents USING btree (incident_type);


--
-- Name: idx_quarantined_files_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quarantined_files_created_at ON public.quarantined_files USING btree (created_at);


--
-- Name: idx_radiology_modality; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_radiology_modality ON public.radiology_orders USING btree (modality);


--
-- Name: idx_radiology_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_radiology_patient_uid ON public.radiology_orders USING btree (patient_uid);


--
-- Name: idx_radiology_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_radiology_status ON public.radiology_orders USING btree (status);


--
-- Name: idx_referrals_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_patient_uid ON public.referrals USING btree (patient_uid);


--
-- Name: idx_referrals_referring_doctor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_referring_doctor ON public.referrals USING btree (referring_doctor);


--
-- Name: idx_referrals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_status ON public.referrals USING btree (status);


--
-- Name: idx_regularization_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_regularization_staff ON public.attendance_regularization USING btree (staff_id);


--
-- Name: idx_replacement_replacement_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_replacement_replacement_staff ON public.replacement_requests USING btree (replacement_staff_id);


--
-- Name: idx_replacement_requester; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_replacement_requester ON public.replacement_requests USING btree (requester_id);


--
-- Name: idx_report_updates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_updates ON public.report_updates USING btree (report_type, report_id);


--
-- Name: idx_revisions_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revisions_staff ON public.salary_revisions USING btree (staff_uid);


--
-- Name: idx_revisions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revisions_status ON public.salary_revisions USING btree (status);


--
-- Name: idx_sched_notif; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_notif ON public.scheduled_notifications USING btree (send_at, status);


--
-- Name: idx_sched_notif_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sched_notif_user ON public.scheduled_notifications USING btree (user_id);


--
-- Name: idx_scheduled_notif_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_notif_status_time ON public.scheduled_notifications USING btree (status, send_at);


--
-- Name: idx_sos_services_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sos_services_name ON public.sos_services USING btree (name);


--
-- Name: idx_staff_attendance_check_out; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_attendance_check_out ON public.staff_attendance USING btree (check_out_time);


--
-- Name: idx_staff_breaks_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_breaks_staff_id ON public.staff_breaks USING btree (staff_id);


--
-- Name: idx_staff_messages_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_messages_recipient ON public.staff_messages USING btree (recipient_uid);


--
-- Name: idx_staff_messages_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_messages_sender ON public.staff_messages USING btree (sender_uid);


--
-- Name: idx_staff_messages_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_messages_unread ON public.staff_messages USING btree (recipient_uid, is_read);


--
-- Name: idx_staff_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_name ON public.staff USING btree (name);


--
-- Name: idx_staff_salary_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_salary_uid ON public.staff_salary USING btree (staff_uid);


--
-- Name: idx_staff_shift_assignments_staff_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staff_shift_assignments_staff_id ON public.staff_shift_assignments USING btree (staff_id);


--
-- Name: idx_system_settings_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_settings_key ON public.system_settings USING btree (key);


--
-- Name: idx_tax_summaries; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tax_summaries ON public.annual_tax_summaries USING btree (staff_uid, financial_year);


--
-- Name: idx_totp_challenges_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_totp_challenges_admin_id ON public.totp_challenges USING btree (admin_id);


--
-- Name: idx_totp_challenges_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_totp_challenges_expires_at ON public.totp_challenges USING btree (expires_at);


--
-- Name: idx_users_abha_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_abha_number ON public.users USING btree (abha_number) WHERE (abha_number IS NOT NULL);


--
-- Name: idx_vital_signs_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vital_signs_patient_uid ON public.vital_signs USING btree (patient_uid);


--
-- Name: idx_vital_signs_recorded_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vital_signs_recorded_date ON public.vital_signs USING btree (recorded_date);


--
-- Name: idx_vital_signs_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vital_signs_type ON public.vital_signs USING btree (type);


--
-- Name: idx_vitals_encounter_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vitals_encounter_id ON public.vitals_chart USING btree (encounter_id);


--
-- Name: idx_vitals_patient_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vitals_patient_uid ON public.vitals_chart USING btree (patient_uid);


--
-- Name: idx_vitals_recorded_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vitals_recorded_at ON public.vitals_chart USING btree (recorded_at);


--
-- Name: idx_wards_department; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wards_department ON public.wards USING btree (department_id);


--
-- Name: insurance_claims_patient_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insurance_claims_patient_uid_idx ON public.insurance_claims USING btree (patient_uid);


--
-- Name: insurance_claims_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insurance_claims_status_idx ON public.insurance_claims USING btree (status);


--
-- Name: insurance_claims_submitted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insurance_claims_submitted_at_idx ON public.insurance_claims USING btree (submitted_at);


--
-- Name: investigation_files_investigation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX investigation_files_investigation_id_idx ON public.investigation_files USING btree (investigation_id);


--
-- Name: investigation_template_tests_template_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX investigation_template_tests_template_id_idx ON public.investigation_template_tests USING btree (template_id);


--
-- Name: investigation_templates_department_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX investigation_templates_department_id_idx ON public.investigation_templates USING btree (department_id);


--
-- Name: investigations_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX investigations_phone_idx ON public.investigations USING btree (phone);


--
-- Name: investigations_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX investigations_priority_idx ON public.investigations USING btree (priority);


--
-- Name: investigations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX investigations_status_idx ON public.investigations USING btree (status);


--
-- Name: investigations_test_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX investigations_test_type_idx ON public.investigations USING btree (test_type);


--
-- Name: investigations_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX investigations_uid_idx ON public.investigations USING btree (uid);


--
-- Name: invoices_invoice_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_invoice_number_idx ON public.invoices USING btree (invoice_number);


--
-- Name: invoices_issued_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_issued_at_idx ON public.invoices USING btree (issued_at);


--
-- Name: invoices_patient_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_patient_uid_idx ON public.invoices USING btree (patient_uid);


--
-- Name: invoices_payment_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_payment_status_idx ON public.invoices USING btree (payment_status);


--
-- Name: invoices_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invoices_type_idx ON public.invoices USING btree (type);


--
-- Name: leave_applications_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leave_applications_staff_id_idx ON public.leave_applications USING btree (staff_id);


--
-- Name: leave_applications_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leave_applications_status_idx ON public.leave_applications USING btree (status);


--
-- Name: leave_balance_overrides_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leave_balance_overrides_staff_id_idx ON public.leave_balance_overrides USING btree (staff_id);


--
-- Name: leave_types_leave_type_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX leave_types_leave_type_key ON public.leave_types USING btree (leave_type);


--
-- Name: medical_activity_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX medical_activity_logs_created_at_idx ON public.medical_activity_logs USING btree (created_at);


--
-- Name: medical_activity_logs_staff_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX medical_activity_logs_staff_uid_idx ON public.medical_activity_logs USING btree (staff_uid);


--
-- Name: medical_records_doctor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX medical_records_doctor_id_idx ON public.medical_records USING btree (doctor_id);


--
-- Name: medical_records_patient_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX medical_records_patient_id_idx ON public.medical_records USING btree (patient_id);


--
-- Name: medications_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX medications_category_idx ON public.medications USING btree (category);


--
-- Name: medications_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX medications_name_idx ON public.medications USING btree (name);


--
-- Name: notification_delivery_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_delivery_log_created_at_idx ON public.notification_delivery_log USING btree (created_at);


--
-- Name: notification_delivery_log_error_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_delivery_log_error_type_idx ON public.notification_delivery_log USING btree (error_type);


--
-- Name: notification_delivery_log_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_delivery_log_status_idx ON public.notification_delivery_log USING btree (status);


--
-- Name: notification_templates_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_templates_type_idx ON public.notification_templates USING btree (type);


--
-- Name: notifications_is_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_is_read_idx ON public.notifications USING btree (is_read);


--
-- Name: notifications_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_phone_idx ON public.notifications USING btree (phone);


--
-- Name: notifications_scheduled_for_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_scheduled_for_idx ON public.notifications USING btree (scheduled_for);


--
-- Name: notifications_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_type_idx ON public.notifications USING btree (type);


--
-- Name: notifications_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_uid_idx ON public.notifications USING btree (uid);


--
-- Name: otp_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otp_logs_created_at_idx ON public.otp_logs USING btree (created_at);


--
-- Name: otp_logs_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otp_logs_phone_idx ON public.otp_logs USING btree (phone);


--
-- Name: otp_sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otp_sessions_expires_at_idx ON public.otp_sessions USING btree (expires_at);


--
-- Name: otp_sessions_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX otp_sessions_phone_idx ON public.otp_sessions USING btree (phone);


--
-- Name: password_reset_otps_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_otps_expires_at_idx ON public.password_reset_otps USING btree (expires_at);


--
-- Name: password_reset_otps_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_otps_user_id_idx ON public.password_reset_otps USING btree (user_id);


--
-- Name: patient_feedback_doctor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patient_feedback_doctor_id_idx ON public.patient_feedback USING btree (doctor_id);


--
-- Name: payment_transactions_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_transactions_created_at_idx ON public.payment_transactions USING btree (created_at);


--
-- Name: payment_transactions_invoice_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_transactions_invoice_id_idx ON public.payment_transactions USING btree (invoice_id);


--
-- Name: pharmacies_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pharmacies_status_idx ON public.pharmacies USING btree (status);


--
-- Name: pharmacy_activity_logs_staff_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pharmacy_activity_logs_staff_uid_idx ON public.pharmacy_activity_logs USING btree (staff_uid);


--
-- Name: pharmacy_orders_ordered_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pharmacy_orders_ordered_at_idx ON public.pharmacy_orders USING btree (ordered_at);


--
-- Name: pharmacy_orders_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pharmacy_orders_phone_idx ON public.pharmacy_orders USING btree (phone);


--
-- Name: pharmacy_orders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pharmacy_orders_status_idx ON public.pharmacy_orders USING btree (status);


--
-- Name: pharmacy_orders_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pharmacy_orders_uid_idx ON public.pharmacy_orders USING btree (uid);


--
-- Name: sos_alerts_alert_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_alerts_alert_type_idx ON public.sos_alerts USING btree (alert_type);


--
-- Name: sos_alerts_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_alerts_phone_idx ON public.sos_alerts USING btree (phone);


--
-- Name: sos_alerts_raised_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_alerts_raised_at_idx ON public.sos_alerts USING btree (raised_at);


--
-- Name: sos_alerts_severity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_alerts_severity_idx ON public.sos_alerts USING btree (severity);


--
-- Name: sos_alerts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_alerts_status_idx ON public.sos_alerts USING btree (status);


--
-- Name: sos_alerts_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sos_alerts_uid_idx ON public.sos_alerts USING btree (uid);


--
-- Name: staff_attendance_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_attendance_staff_id_idx ON public.staff_attendance USING btree (staff_id);


--
-- Name: staff_attendance_staff_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_attendance_staff_uid_idx ON public.staff_attendance USING btree (staff_uid);


--
-- Name: staff_attendance_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_attendance_timestamp_idx ON public.staff_attendance USING btree ("timestamp");


--
-- Name: staff_attendance_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_attendance_type_idx ON public.staff_attendance USING btree (type);


--
-- Name: staff_auth_sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_auth_sessions_expires_at_idx ON public.staff_auth_sessions USING btree (expires_at);


--
-- Name: staff_auth_sessions_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_auth_sessions_staff_id_idx ON public.staff_auth_sessions USING btree (staff_id);


--
-- Name: staff_department_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_department_idx ON public.staff USING btree (department);


--
-- Name: staff_devices_device_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_devices_device_id_idx ON public.staff_devices USING btree (device_id);


--
-- Name: staff_devices_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_devices_staff_id_idx ON public.staff_devices USING btree (staff_id);


--
-- Name: staff_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_is_active_idx ON public.staff USING btree (is_active);


--
-- Name: staff_onboarding_tasks_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_onboarding_tasks_staff_id_idx ON public.staff_onboarding_tasks USING btree (staff_id);


--
-- Name: staff_performance_reviews_staff_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_performance_reviews_staff_id_idx ON public.staff_performance_reviews USING btree (staff_id);


--
-- Name: staff_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX staff_user_id_idx ON public.staff USING btree (user_id);


--
-- Name: step_profiles_user_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_profiles_user_uid_idx ON public.step_profiles USING btree (user_uid);


--
-- Name: step_profiles_user_uid_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX step_profiles_user_uid_key ON public.step_profiles USING btree (user_uid);


--
-- Name: step_rewards_reward_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_rewards_reward_month_idx ON public.step_rewards USING btree (reward_month);


--
-- Name: step_rewards_user_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_rewards_user_uid_idx ON public.step_rewards USING btree (user_uid);


--
-- Name: step_rewards_user_uid_is_applied_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_rewards_user_uid_is_applied_idx ON public.step_rewards USING btree (user_uid, is_applied);


--
-- Name: step_sessions_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_sessions_started_at_idx ON public.step_sessions USING btree (started_at);


--
-- Name: step_sessions_user_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_sessions_user_uid_idx ON public.step_sessions USING btree (user_uid);


--
-- Name: step_sessions_user_uid_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX step_sessions_user_uid_started_at_idx ON public.step_sessions USING btree (user_uid, started_at);


--
-- Name: system_alerts_alert_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_alerts_alert_type_idx ON public.system_alerts USING btree (alert_type);


--
-- Name: system_alerts_severity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_alerts_severity_idx ON public.system_alerts USING btree (severity);


--
-- Name: user_action_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_action_logs_created_at_idx ON public.user_action_logs USING btree (created_at);


--
-- Name: user_action_logs_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_action_logs_user_id_idx ON public.user_action_logs USING btree (user_id);


--
-- Name: user_deactivation_log_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_deactivation_log_user_id_idx ON public.user_deactivation_log USING btree (user_id);


--
-- Name: user_devices_user_uid_device_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_devices_user_uid_device_id_key ON public.user_devices USING btree (user_uid, device_id);


--
-- Name: user_devices_user_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_devices_user_uid_idx ON public.user_devices USING btree (user_uid);


--
-- Name: user_reactivation_log_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_reactivation_log_user_id_idx ON public.user_reactivation_log USING btree (user_id);


--
-- Name: user_role_audit_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_role_audit_phone_idx ON public.user_role_audit USING btree (phone);


--
-- Name: user_sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_sessions_expires_at_idx ON public.user_sessions USING btree (expires_at);


--
-- Name: user_sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_sessions_user_id_idx ON public.user_sessions USING btree (user_id);


--
-- Name: user_status_history_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_status_history_user_id_idx ON public.user_status_history USING btree (user_id);


--
-- Name: users_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_phone_idx ON public.users USING btree (phone);


--
-- Name: users_phone_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_phone_key ON public.users USING btree (phone);


--
-- Name: users_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_role_idx ON public.users USING btree (role);


--
-- Name: users_uid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_uid_idx ON public.users USING btree (uid);


--
-- Name: users_uid_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_uid_key ON public.users USING btree (uid);


--
-- Name: staff_grievances grievance_number_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER grievance_number_trigger BEFORE INSERT ON public.staff_grievances FOR EACH ROW EXECUTE FUNCTION public.generate_grievance_number();


--
-- Name: housekeeping_logs hk_log_number_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hk_log_number_trigger BEFORE INSERT ON public.housekeeping_logs FOR EACH ROW EXECUTE FUNCTION public.generate_hk_log_number();


--
-- Name: housekeeping_requests hk_req_number_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hk_req_number_trigger BEFORE INSERT ON public.housekeeping_requests FOR EACH ROW EXECUTE FUNCTION public.generate_hk_req_number();


--
-- Name: incident_reports incident_number_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER incident_number_trigger BEFORE INSERT ON public.incident_reports FOR EACH ROW EXECUTE FUNCTION public.generate_incident_number();


--
-- Name: salary_revisions revision_number_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revision_number_trigger BEFORE INSERT ON public.salary_revisions FOR EACH ROW EXECUTE FUNCTION public.generate_revision_number();


--
-- Name: investigation_bookings trg_inv_booking_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_inv_booking_number BEFORE INSERT ON public.investigation_bookings FOR EACH ROW WHEN ((new.booking_number IS NULL)) EXECUTE FUNCTION public.generate_inv_booking_number();


--
-- Name: pharmacy_orders trg_pharmacy_order_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_pharmacy_order_number BEFORE INSERT ON public.pharmacy_orders FOR EACH ROW WHEN ((new.order_number IS NULL)) EXECUTE FUNCTION public.generate_pharmacy_order_number();


--
-- Name: e_prescriptions trg_rx_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_rx_number BEFORE INSERT ON public.e_prescriptions FOR EACH ROW WHEN ((new.prescription_number IS NULL)) EXECUTE FUNCTION public.generate_rx_number();


--
-- Name: admissions admissions_bed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admissions
    ADD CONSTRAINT admissions_bed_id_fkey FOREIGN KEY (bed_id) REFERENCES public.beds(id) ON DELETE SET NULL;


--
-- Name: advance_deductions advance_deductions_advance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.advance_deductions
    ADD CONSTRAINT advance_deductions_advance_id_fkey FOREIGN KEY (advance_id) REFERENCES public.salary_advances(id);


--
-- Name: advance_deductions advance_deductions_payslip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.advance_deductions
    ADD CONSTRAINT advance_deductions_payslip_id_fkey FOREIGN KEY (payslip_id) REFERENCES public.payslips(id);


--
-- Name: annual_review_reminders annual_review_reminders_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_review_reminders
    ADD CONSTRAINT annual_review_reminders_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.salary_revisions(id);


--
-- Name: annual_review_reminders annual_review_reminders_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_review_reminders
    ADD CONSTRAINT annual_review_reminders_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: annual_tax_summaries annual_tax_summaries_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.annual_tax_summaries
    ADD CONSTRAINT annual_tax_summaries_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: appointment_documents appointment_documents_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_documents
    ADD CONSTRAINT appointment_documents_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;


--
-- Name: appointment_documents appointment_documents_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_documents
    ADD CONSTRAINT appointment_documents_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: appointment_documents appointment_documents_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_documents
    ADD CONSTRAINT appointment_documents_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: appointment_documents appointment_documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_documents
    ADD CONSTRAINT appointment_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: appointment_status_history appointment_status_history_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_status_history
    ADD CONSTRAINT appointment_status_history_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id) ON DELETE CASCADE;


--
-- Name: appointment_status_history appointment_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointment_status_history
    ADD CONSTRAINT appointment_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: appointments appointments_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: appointments appointments_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: attendance_disputes attendance_disputes_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_disputes
    ADD CONSTRAINT attendance_disputes_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: attendance_disputes attendance_disputes_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_disputes
    ADD CONSTRAINT attendance_disputes_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id);


--
-- Name: attendance_regularization attendance_regularization_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_regularization
    ADD CONSTRAINT attendance_regularization_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id);


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: bed_transfers bed_transfers_admission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bed_transfers
    ADD CONSTRAINT bed_transfers_admission_id_fkey FOREIGN KEY (admission_id) REFERENCES public.admissions(id) ON DELETE SET NULL;


--
-- Name: bed_transfers bed_transfers_from_bed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bed_transfers
    ADD CONSTRAINT bed_transfers_from_bed_id_fkey FOREIGN KEY (from_bed_id) REFERENCES public.beds(id) ON DELETE SET NULL;


--
-- Name: bed_transfers bed_transfers_to_bed_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bed_transfers
    ADD CONSTRAINT bed_transfers_to_bed_id_fkey FOREIGN KEY (to_bed_id) REFERENCES public.beds(id) ON DELETE SET NULL;


--
-- Name: beds beds_ward_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beds
    ADD CONSTRAINT beds_ward_id_fkey FOREIGN KEY (ward_id) REFERENCES public.wards(id) ON DELETE SET NULL;


--
-- Name: clinical_alerts clinical_alerts_acknowledged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_alerts
    ADD CONSTRAINT clinical_alerts_acknowledged_by_fkey FOREIGN KEY (acknowledged_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: clinical_alerts clinical_alerts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_alerts
    ADD CONSTRAINT clinical_alerts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: clinical_alerts clinical_alerts_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_alerts
    ADD CONSTRAINT clinical_alerts_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: clinical_notes clinical_notes_parent_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clinical_notes
    ADD CONSTRAINT clinical_notes_parent_note_id_fkey FOREIGN KEY (parent_note_id) REFERENCES public.clinical_notes(id) ON DELETE SET NULL;


--
-- Name: delivery_location_updates delivery_location_updates_delivery_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_location_updates
    ADD CONSTRAINT delivery_location_updates_delivery_person_id_fkey FOREIGN KEY (delivery_person_id) REFERENCES public.users(id);


--
-- Name: discharge_summaries discharge_summaries_admission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discharge_summaries
    ADD CONSTRAINT discharge_summaries_admission_id_fkey FOREIGN KEY (admission_id) REFERENCES public.admissions(id) ON DELETE SET NULL;


--
-- Name: e_prescriptions e_prescriptions_appointment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e_prescriptions
    ADD CONSTRAINT e_prescriptions_appointment_id_fkey FOREIGN KEY (appointment_id) REFERENCES public.appointments(id);


--
-- Name: e_prescriptions e_prescriptions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e_prescriptions
    ADD CONSTRAINT e_prescriptions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: e_prescriptions e_prescriptions_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e_prescriptions
    ADD CONSTRAINT e_prescriptions_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.users(id);


--
-- Name: e_prescriptions e_prescriptions_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e_prescriptions
    ADD CONSTRAINT e_prescriptions_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id);


--
-- Name: e_prescriptions e_prescriptions_pharmacy_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.e_prescriptions
    ADD CONSTRAINT e_prescriptions_pharmacy_order_id_fkey FOREIGN KEY (pharmacy_order_id) REFERENCES public.pharmacy_orders(id);


--
-- Name: feedback_responses feedback_responses_feedback_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_responses
    ADD CONSTRAINT feedback_responses_feedback_id_fkey FOREIGN KEY (feedback_id) REFERENCES public.feedback(id) ON DELETE CASCADE;


--
-- Name: payment_transactions fk_payment_transactions_invoice; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_transactions
    ADD CONSTRAINT fk_payment_transactions_invoice FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;


--
-- Name: full_final_settlements full_final_settlements_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.full_final_settlements
    ADD CONSTRAINT full_final_settlements_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: geofence_breaches geofence_breaches_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_breaches
    ADD CONSTRAINT geofence_breaches_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id);


--
-- Name: housekeeping_logs housekeeping_logs_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_logs
    ADD CONSTRAINT housekeeping_logs_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id);


--
-- Name: housekeeping_logs housekeeping_logs_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_logs
    ADD CONSTRAINT housekeeping_logs_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id);


--
-- Name: housekeeping_logs housekeeping_logs_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_logs
    ADD CONSTRAINT housekeeping_logs_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.housekeeping_zones(id);


--
-- Name: housekeeping_request_updates housekeeping_request_updates_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_request_updates
    ADD CONSTRAINT housekeeping_request_updates_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: housekeeping_request_updates housekeeping_request_updates_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_request_updates
    ADD CONSTRAINT housekeeping_request_updates_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.housekeeping_requests(id) ON DELETE CASCADE;


--
-- Name: housekeeping_requests housekeeping_requests_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_requests
    ADD CONSTRAINT housekeeping_requests_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.users(id);


--
-- Name: housekeeping_requests housekeeping_requests_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_requests
    ADD CONSTRAINT housekeeping_requests_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: housekeeping_requests housekeeping_requests_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_requests
    ADD CONSTRAINT housekeeping_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id);


--
-- Name: housekeeping_requests housekeeping_requests_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_requests
    ADD CONSTRAINT housekeeping_requests_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id);


--
-- Name: housekeeping_requests housekeeping_requests_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.housekeeping_requests
    ADD CONSTRAINT housekeeping_requests_zone_id_fkey FOREIGN KEY (zone_id) REFERENCES public.housekeeping_zones(id);


--
-- Name: incident_reports incident_reports_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: incident_reports incident_reports_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id);


--
-- Name: incident_reports incident_reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.users(id);


--
-- Name: incident_reports incident_reports_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.incident_reports
    ADD CONSTRAINT incident_reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: investigation_booking_history investigation_booking_history_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_booking_history
    ADD CONSTRAINT investigation_booking_history_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.investigation_bookings(id) ON DELETE CASCADE;


--
-- Name: investigation_booking_history investigation_booking_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_booking_history
    ADD CONSTRAINT investigation_booking_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: investigation_bookings investigation_bookings_assigned_collector_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_bookings
    ADD CONSTRAINT investigation_bookings_assigned_collector_fkey FOREIGN KEY (assigned_collector) REFERENCES public.users(id);


--
-- Name: investigation_bookings investigation_bookings_collected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_bookings
    ADD CONSTRAINT investigation_bookings_collected_by_fkey FOREIGN KEY (collected_by) REFERENCES public.users(id);


--
-- Name: investigation_bookings investigation_bookings_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_bookings
    ADD CONSTRAINT investigation_bookings_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id);


--
-- Name: investigation_bookings investigation_bookings_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_bookings
    ADD CONSTRAINT investigation_bookings_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: investigation_bookings investigation_bookings_result_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigation_bookings
    ADD CONSTRAINT investigation_bookings_result_uploaded_by_fkey FOREIGN KEY (result_uploaded_by) REFERENCES public.users(id);


--
-- Name: investigations investigations_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investigations
    ADD CONSTRAINT investigations_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: investment_declarations investment_declarations_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.investment_declarations
    ADD CONSTRAINT investment_declarations_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: leave_encashments leave_encashments_fnf_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_encashments
    ADD CONSTRAINT leave_encashments_fnf_id_fkey FOREIGN KEY (fnf_id) REFERENCES public.full_final_settlements(id);


--
-- Name: leave_encashments leave_encashments_payslip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_encashments
    ADD CONSTRAINT leave_encashments_payslip_id_fkey FOREIGN KEY (payslip_id) REFERENCES public.payslips(id);


--
-- Name: leave_encashments leave_encashments_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leave_encashments
    ADD CONSTRAINT leave_encashments_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: medication_administrations medication_administrations_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.medication_administrations
    ADD CONSTRAINT medication_administrations_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.clinical_orders(id) ON DELETE SET NULL;


--
-- Name: notification_outbox notification_outbox_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: overtime_requests overtime_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overtime_requests
    ADD CONSTRAINT overtime_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id);


--
-- Name: overtime_requests overtime_requests_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.overtime_requests
    ADD CONSTRAINT overtime_requests_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id);


--
-- Name: patient_records patient_records_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_records
    ADD CONSTRAINT patient_records_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: patient_records patient_records_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_records
    ADD CONSTRAINT patient_records_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: payroll_runs payroll_runs_generated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_generated_by_fkey FOREIGN KEY (generated_by) REFERENCES public.users(uid);


--
-- Name: payroll_runs payroll_runs_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payroll_runs
    ADD CONSTRAINT payroll_runs_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES public.users(uid);


--
-- Name: payslip_queries payslip_queries_payslip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslip_queries
    ADD CONSTRAINT payslip_queries_payslip_id_fkey FOREIGN KEY (payslip_id) REFERENCES public.payslips(id);


--
-- Name: payslip_query_replies payslip_query_replies_query_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslip_query_replies
    ADD CONSTRAINT payslip_query_replies_query_id_fkey FOREIGN KEY (query_id) REFERENCES public.payslip_queries(id);


--
-- Name: payslips payslips_payroll_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_payroll_run_id_fkey FOREIGN KEY (payroll_run_id) REFERENCES public.payroll_runs(id);


--
-- Name: payslips payslips_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: pharmacy_order_history pharmacy_order_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_order_history
    ADD CONSTRAINT pharmacy_order_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: pharmacy_order_history pharmacy_order_history_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_order_history
    ADD CONSTRAINT pharmacy_order_history_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pharmacy_orders(id) ON DELETE CASCADE;


--
-- Name: pharmacy_orders pharmacy_orders_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_orders
    ADD CONSTRAINT pharmacy_orders_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id);


--
-- Name: pharmacy_orders pharmacy_orders_dispatched_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_orders
    ADD CONSTRAINT pharmacy_orders_dispatched_by_fkey FOREIGN KEY (dispatched_by) REFERENCES public.users(id);


--
-- Name: pharmacy_orders pharmacy_orders_patient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pharmacy_orders
    ADD CONSTRAINT pharmacy_orders_patient_id_fkey FOREIGN KEY (patient_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: replacement_requests replacement_requests_hr_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_requests
    ADD CONSTRAINT replacement_requests_hr_approved_by_fkey FOREIGN KEY (hr_approved_by) REFERENCES public.users(id);


--
-- Name: replacement_requests replacement_requests_replacement_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_requests
    ADD CONSTRAINT replacement_requests_replacement_staff_id_fkey FOREIGN KEY (replacement_staff_id) REFERENCES public.users(id);


--
-- Name: replacement_requests replacement_requests_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_requests
    ADD CONSTRAINT replacement_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id);


--
-- Name: report_updates report_updates_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_updates
    ADD CONSTRAINT report_updates_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: salary_advances salary_advances_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_advances
    ADD CONSTRAINT salary_advances_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(uid);


--
-- Name: salary_advances salary_advances_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_advances
    ADD CONSTRAINT salary_advances_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: salary_arrears salary_arrears_payslip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_arrears
    ADD CONSTRAINT salary_arrears_payslip_id_fkey FOREIGN KEY (payslip_id) REFERENCES public.payslips(id);


--
-- Name: salary_arrears salary_arrears_revision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_arrears
    ADD CONSTRAINT salary_arrears_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES public.salary_revisions(id);


--
-- Name: salary_arrears salary_arrears_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_arrears
    ADD CONSTRAINT salary_arrears_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: salary_revisions salary_revisions_admin_signed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_admin_signed_by_fkey FOREIGN KEY (admin_signed_by) REFERENCES public.users(uid);


--
-- Name: salary_revisions salary_revisions_hr_signed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_hr_signed_by_fkey FOREIGN KEY (hr_signed_by) REFERENCES public.users(uid);


--
-- Name: salary_revisions salary_revisions_proposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.users(uid);


--
-- Name: salary_revisions salary_revisions_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES public.users(uid);


--
-- Name: salary_revisions salary_revisions_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salary_revisions
    ADD CONSTRAINT salary_revisions_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: scheduled_notifications scheduled_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_notifications
    ADD CONSTRAINT scheduled_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: staff_breaks staff_breaks_attendance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_breaks
    ADD CONSTRAINT staff_breaks_attendance_id_fkey FOREIGN KEY (attendance_id) REFERENCES public.staff_attendance(id);


--
-- Name: staff_breaks staff_breaks_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_breaks
    ADD CONSTRAINT staff_breaks_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id);


--
-- Name: staff_grievances staff_grievances_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_grievances
    ADD CONSTRAINT staff_grievances_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: staff_grievances staff_grievances_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_grievances
    ADD CONSTRAINT staff_grievances_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.users(id);


--
-- Name: staff_grievances staff_grievances_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_grievances
    ADD CONSTRAINT staff_grievances_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: staff_salary staff_salary_staff_uid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_salary
    ADD CONSTRAINT staff_salary_staff_uid_fkey FOREIGN KEY (staff_uid) REFERENCES public.users(uid);


--
-- Name: staff_shift_assignments staff_shift_assignments_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shift_assignments
    ADD CONSTRAINT staff_shift_assignments_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.staff_shifts(id);


--
-- Name: staff_shift_assignments staff_shift_assignments_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staff_shift_assignments
    ADD CONSTRAINT staff_shift_assignments_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

