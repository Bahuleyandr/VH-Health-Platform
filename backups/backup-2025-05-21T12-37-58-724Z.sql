--
-- PostgreSQL database dump
--

-- Dumped from database version 17.5
-- Dumped by pg_dump version 17.5

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: appointments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.appointments (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    doctor_name character varying(100) NOT NULL,
    date date NOT NULL,
    "time" character varying(10) NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.appointments OWNER TO postgres;

--
-- Name: appointments_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.appointments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.appointments_id_seq OWNER TO postgres;

--
-- Name: appointments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.appointments_id_seq OWNED BY public.appointments.id;


--
-- Name: consultations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.consultations (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    file_name character varying(255) NOT NULL,
    file_type character varying(50) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    file_key text
);


ALTER TABLE public.consultations OWNER TO postgres;

--
-- Name: consultations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.consultations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.consultations_id_seq OWNER TO postgres;

--
-- Name: consultations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.consultations_id_seq OWNED BY public.consultations.id;


--
-- Name: departments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.departments (
    id integer NOT NULL,
    name character varying(100) NOT NULL
);


ALTER TABLE public.departments OWNER TO postgres;

--
-- Name: departments_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.departments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.departments_id_seq OWNER TO postgres;

--
-- Name: departments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.departments_id_seq OWNED BY public.departments.id;


--
-- Name: doctors; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.doctors (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    department character varying(100) NOT NULL,
    intro text,
    image_url text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    department_id integer,
    specialty text
);


ALTER TABLE public.doctors OWNER TO postgres;

--
-- Name: doctors_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.doctors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.doctors_id_seq OWNER TO postgres;

--
-- Name: doctors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.doctors_id_seq OWNED BY public.doctors.id;


--
-- Name: feedback; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.feedback (
    id integer NOT NULL,
    phonenumber character varying(15) NOT NULL,
    rating integer NOT NULL,
    comment text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT feedback_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


ALTER TABLE public.feedback OWNER TO postgres;

--
-- Name: feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.feedback_id_seq OWNER TO postgres;

--
-- Name: feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.feedback_id_seq OWNED BY public.feedback.id;


--
-- Name: file_metadata; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.file_metadata (
    id integer NOT NULL,
    file_name text NOT NULL,
    file_type text NOT NULL,
    storage_key text NOT NULL,
    storage_url text NOT NULL,
    file_size bigint NOT NULL,
    uploaded_by text,
    uploaded_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE public.file_metadata OWNER TO postgres;

--
-- Name: file_metadata_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.file_metadata_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.file_metadata_id_seq OWNER TO postgres;

--
-- Name: file_metadata_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.file_metadata_id_seq OWNED BY public.file_metadata.id;


--
-- Name: health_records; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.health_records (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    file_name character varying(255) NOT NULL,
    file_type character varying(50) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    file_key text
);


ALTER TABLE public.health_records OWNER TO postgres;

--
-- Name: health_records_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.health_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.health_records_id_seq OWNER TO postgres;

--
-- Name: health_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.health_records_id_seq OWNED BY public.health_records.id;


--
-- Name: investigations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.investigations (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    test_name character varying(255) NOT NULL,
    status character varying(50) DEFAULT 'requested'::character varying,
    requested_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    result_file text,
    file_key text
);


ALTER TABLE public.investigations OWNER TO postgres;

--
-- Name: investigations_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.investigations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.investigations_id_seq OWNER TO postgres;

--
-- Name: investigations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.investigations_id_seq OWNED BY public.investigations.id;


--
-- Name: pharmacy_orders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.pharmacy_orders (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    order_note text NOT NULL,
    status character varying(50) DEFAULT 'requested'::character varying,
    ordered_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    file_key text,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.pharmacy_orders OWNER TO postgres;

--
-- Name: pharmacy_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.pharmacy_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.pharmacy_orders_id_seq OWNER TO postgres;

--
-- Name: pharmacy_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.pharmacy_orders_id_seq OWNED BY public.pharmacy_orders.id;


--
-- Name: sos_alerts; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sos_alerts (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    latitude character varying(50) NOT NULL,
    longitude character varying(50) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    ip_address text
);


ALTER TABLE public.sos_alerts OWNER TO postgres;

--
-- Name: sos_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.sos_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.sos_alerts_id_seq OWNER TO postgres;

--
-- Name: sos_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.sos_alerts_id_seq OWNED BY public.sos_alerts.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id integer NOT NULL,
    phone character varying(15) NOT NULL,
    registered_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    name text,
    gender text,
    address text,
    email text,
    birthday date,
    anniversary date,
    profile_picture text,
    uid uuid DEFAULT gen_random_uuid()
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO postgres;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: appointments id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointments ALTER COLUMN id SET DEFAULT nextval('public.appointments_id_seq'::regclass);


--
-- Name: consultations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.consultations ALTER COLUMN id SET DEFAULT nextval('public.consultations_id_seq'::regclass);


--
-- Name: departments id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.departments ALTER COLUMN id SET DEFAULT nextval('public.departments_id_seq'::regclass);


--
-- Name: doctors id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.doctors ALTER COLUMN id SET DEFAULT nextval('public.doctors_id_seq'::regclass);


--
-- Name: feedback id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.feedback ALTER COLUMN id SET DEFAULT nextval('public.feedback_id_seq'::regclass);


--
-- Name: file_metadata id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.file_metadata ALTER COLUMN id SET DEFAULT nextval('public.file_metadata_id_seq'::regclass);


--
-- Name: health_records id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.health_records ALTER COLUMN id SET DEFAULT nextval('public.health_records_id_seq'::regclass);


--
-- Name: investigations id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.investigations ALTER COLUMN id SET DEFAULT nextval('public.investigations_id_seq'::regclass);


--
-- Name: pharmacy_orders id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pharmacy_orders ALTER COLUMN id SET DEFAULT nextval('public.pharmacy_orders_id_seq'::regclass);


--
-- Name: sos_alerts id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sos_alerts ALTER COLUMN id SET DEFAULT nextval('public.sos_alerts_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: appointments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.appointments (id, phone, doctor_name, date, "time", status, created_at) FROM stdin;
1	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 17:43:17.98529
2	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 17:53:51.139758
3	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 18:01:51.183411
4	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 18:05:34.335878
5	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 18:14:05.185187
6	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 18:19:47.909201
7	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 18:21:46.030942
8	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 18:32:48.762186
9	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-15 19:24:49.90635
10	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-16 01:15:55.124398
11	+919876543210	Dr. Test	2025-05-20	10:00 AM	pending	2025-05-16 02:07:34.413469
12	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-16 16:56:22.125024
13	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-16 20:05:39.058918
14	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-17 17:50:55.291046
15	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-20 20:20:14.69251
16	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-20 20:20:18.97002
17	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-20 20:22:20.728883
18	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-20 20:29:48.723665
19	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-20 20:35:01.01586
20	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-20 20:53:51.218854
21	9876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-20 20:57:48.312389
25	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 00:43:04.321843
26	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 00:43:08.285626
27	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 00:47:49.54728
28	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 00:51:19.237701
29	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 00:54:39.385147
30	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 01:13:59.920354
31	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 01:28:54.4697
32	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 01:40:49.069428
33	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 11:49:12.810363
34	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 11:55:26.136984
35	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 12:10:52.724845
36	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 12:49:32.344956
37	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 12:52:53.610617
38	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 12:53:19.170283
39	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 13:59:57.362041
40	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 16:49:00.217268
41	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 17:44:19.717559
42	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 17:51:58.539781
43	+919876543210	Dr. Smith	2025-06-01	10:00	pending	2025-05-21 17:54:43.321662
\.


--
-- Data for Name: consultations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.consultations (id, phone, file_name, file_type, created_at, file_key) FROM stdin;
1	9876543210	consultation_summary.pdf	pdf	2025-05-15 17:43:19.041364	\N
2	9876543210	consultation_summary.pdf	pdf	2025-05-15 17:53:52.155793	\N
3	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:01:52.089536	\N
4	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:05:35.34968	\N
5	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:14:06.138065	\N
6	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:19:48.862431	\N
7	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:21:47.016428	\N
8	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:32:49.797513	\N
9	9876543210	consultation_summary.pdf	pdf	2025-05-15 19:24:50.894905	\N
10	9876543210	consultation_summary.pdf	pdf	2025-05-16 01:15:56.094634	\N
11	9876543210	consultation_summary.pdf	pdf	2025-05-16 16:56:23.149053	\N
12	9876543210	consultation_summary.pdf	pdf	2025-05-16 20:50:21.100497	\N
13	9876543210	consultation_summary.pdf	pdf	2025-05-17 17:52:16.792626	\N
16	+919876543210	consultation_summary.pdf	pdf	2025-05-21 01:13:52.329275	uploads/consultation_summary.pdf
17	+919876543210	consultation_summary.pdf	pdf	2025-05-21 01:14:01.012861	uploads/consultation_summary.pdf
18	+919876543210	consultation_summary.pdf	pdf	2025-05-21 01:28:55.535137	uploads/consultation_summary.pdf
19	+919876543210	consultation_summary.pdf	pdf	2025-05-21 01:40:50.191791	uploads/consultation_summary.pdf
20	+919876543210	consultation_summary.pdf	pdf	2025-05-21 11:49:13.90839	uploads/consultation_summary.pdf
21	+919876543210	consultation_summary.pdf	pdf	2025-05-21 11:55:27.342002	uploads/consultation_summary.pdf
22	+919876543210	consultation_summary.pdf	pdf	2025-05-21 12:10:53.759507	uploads/consultation_summary.pdf
23	+919876543210	consultation_summary.pdf	pdf	2025-05-21 12:49:33.157212	uploads/consultation_summary.pdf
24	+919876543210	consultation_summary.pdf	pdf	2025-05-21 12:52:54.708013	uploads/consultation_summary.pdf
25	+919876543210	consultation_summary.pdf	pdf	2025-05-21 12:53:20.344286	uploads/consultation_summary.pdf
26	+919876543210	consultation_summary.pdf	pdf	2025-05-21 13:59:58.589904	uploads/consultation_summary.pdf
27	+919876543210	consultation_summary.pdf	pdf	2025-05-21 16:49:01.368954	uploads/consultation_summary.pdf
28	+919876543210	consultation_summary.pdf	pdf	2025-05-21 17:44:20.994606	uploads/consultation_summary.pdf
29	+919876543210	consultation_summary.pdf	pdf	2025-05-21 17:54:44.394399	uploads/consultation_summary.pdf
\.


--
-- Data for Name: departments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.departments (id, name) FROM stdin;
3	Cardiology
\.


--
-- Data for Name: doctors; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.doctors (id, name, department, intro, image_url, created_at, department_id, specialty) FROM stdin;
30	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 00:51:21.185558	\N	\N
31	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 00:54:41.142815	\N	\N
32	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 01:14:01.714042	\N	\N
33	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 01:28:56.255708	\N	\N
34	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 01:40:50.817882	\N	\N
35	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 11:49:14.516086	\N	\N
36	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 12:10:54.396642	\N	\N
37	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 12:49:33.929727	\N	\N
38	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 12:52:55.422926	\N	\N
39	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 12:53:21.01735	\N	\N
40	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 13:59:59.258101	\N	\N
41	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 16:49:02.045935	\N	\N
14	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-17 17:53:02.842857	3	General Medicine
13	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-16 21:03:45.342525	3	General Medicine
12	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-16 16:56:23.589776	3	General Medicine
11	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-16 01:15:56.550324	3	General Medicine
10	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-15 19:24:51.296482	3	General Medicine
9	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-15 18:32:50.254147	3	General Medicine
8	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-15 18:21:47.42076	3	General Medicine
7	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-15 18:19:49.330312	3	General Medicine
6	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-15 18:14:06.587952	3	General Medicine
5	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-15 18:05:35.830361	3	General Medicine
4	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-15 18:01:52.571063	3	General Medicine
2	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-15 17:43:19.574072	3	General Medicine
15	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 17:38:22.272297	\N	\N
16	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 17:47:15.197622	\N	\N
17	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 20:07:24.621056	\N	\N
18	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 20:20:20.854298	\N	\N
19	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 20:29:50.535694	\N	\N
20	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 20:35:02.899024	\N	\N
21	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 20:53:52.989743	\N	\N
22	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 20:57:50.066186	\N	\N
23	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 23:18:11.314245	\N	\N
24	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-20 23:24:29.340673	\N	\N
25	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 00:23:57.954136	\N	\N
26	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 00:30:43.144074	\N	\N
27	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 00:38:02.796636	\N	\N
28	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 00:43:10.076328	\N	\N
29	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 00:47:51.393691	\N	\N
42	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 17:44:21.594872	\N	\N
43	Dr. John Doe	Cardiology	Expert in heart health	https://example.com/images/dr-john.jpg	2025-05-21 17:54:45.03016	\N	\N
\.


--
-- Data for Name: feedback; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.feedback (id, phonenumber, rating, comment, created_at) FROM stdin;
1	9876543210	5	Excellent service	2025-05-15 17:53:51.753937
2	9876543210	5	Excellent service	2025-05-15 18:01:51.75276
3	9876543210	5	Excellent service	2025-05-15 18:05:34.947012
4	9876543210	5	Excellent service	2025-05-15 18:14:05.795154
5	9876543210	5	Excellent service	2025-05-15 18:19:48.521447
6	9876543210	5	Excellent service	2025-05-15 18:21:46.653908
7	9876543210	5	Excellent service	2025-05-15 18:32:49.405627
8	9876543210	5	Excellent service	2025-05-15 19:24:50.503905
9	9876543210	5	Excellent service	2025-05-16 01:15:55.721117
10	+919876543210	5	Great service!	2025-05-16 03:42:02.970483
11	9876543210	5	Excellent service	2025-05-16 20:41:44.313312
12	9876543210	5	Excellent service	2025-05-17 17:52:07.81798
13	9876543210	5	Excellent service	2025-05-20 17:38:21.511845
14	9876543210	5	Excellent service	2025-05-20 17:47:14.310142
15	9876543210	5	Excellent service	2025-05-20 20:07:23.785681
16	9876543210	5	Excellent service	2025-05-20 23:18:10.475134
17	9876543210	5	Excellent service	2025-05-20 23:24:28.538212
18	9876543210	5	Excellent service	2025-05-21 00:23:57.112716
19	9876543210	5	Excellent service	2025-05-21 00:30:42.301228
20	9876543210	5	Excellent service	2025-05-21 00:38:01.96577
21	9876543210	5	Excellent service	2025-05-21 00:43:09.261015
22	9876543210	5	Excellent service	2025-05-21 00:47:50.598642
23	9876543210	5	Excellent service	2025-05-21 00:51:20.331773
24	9876543210	5	Excellent service	2025-05-21 00:54:40.341739
25	9876543210	5	Excellent service	2025-05-21 01:14:00.872861
26	9876543210	5	Excellent service	2025-05-21 01:28:55.376143
27	9876543210	5	Excellent service	2025-05-21 01:40:50.050611
28	9876543210	5	Excellent service	2025-05-21 11:49:13.753387
29	9876543210	5	Excellent service	2025-05-21 12:10:53.666818
30	9876543210	5	Excellent service	2025-05-21 12:49:33.049639
31	9876543210	5	Excellent service	2025-05-21 12:52:54.53775
32	9876543210	5	Excellent service	2025-05-21 12:53:20.171466
33	9876543210	5	Excellent service	2025-05-21 13:59:58.43403
34	9876543210	5	Excellent service	2025-05-21 16:49:01.242078
35	9876543210	5	Excellent service	2025-05-21 17:44:20.804993
36	9876543210	5	Excellent service	2025-05-21 17:54:44.300967
\.


--
-- Data for Name: file_metadata; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.file_metadata (id, file_name, file_type, storage_key, storage_url, file_size, uploaded_by, uploaded_at) FROM stdin;
2	test.jpg	image/jpeg	uploads/1747826302533_test.jpg	https://dbe488236c64499a3dfc797a750c912d.r2.cloudflarestorage.com/uploads/1747826302533_test.jpg	0	test-admin-uid	2025-05-21 16:48:23.029644
\.


--
-- Data for Name: health_records; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.health_records (id, phone, file_name, file_type, created_at, file_key) FROM stdin;
1	9876543210	prescription_may15.pdf	prescription	2025-05-12 13:01:12.48381	\N
2	9876543210	prescription_may15.pdf	prescription	2025-05-12 14:21:01.908772	\N
3	9876543210	prescription_may15.pdf	prescription	2025-05-12 23:27:01.449493	\N
4	9876543210	consultation_summary.pdf	pdf	2025-05-15 17:43:18.496546	\N
5	9876543210	consultation_summary.pdf	pdf	2025-05-15 17:53:51.597417	\N
6	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:01:51.611445	\N
7	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:05:34.803659	\N
8	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:14:05.670954	\N
9	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:19:48.363912	\N
10	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:21:46.546568	\N
11	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:32:49.263759	\N
12	9876543210	consultation_summary.pdf	pdf	2025-05-15 19:24:50.330709	\N
13	9876543210	consultation_summary.pdf	pdf	2025-05-16 01:15:55.546634	\N
14	+919876543210	record_test.pdf	application/pdf	2025-05-16 03:41:35.083484	\N
15	9876543210	consultation_summary.pdf	pdf	2025-05-16 20:33:37.761672	\N
16	9876543210	consultation_summary.pdf	pdf	2025-05-17 17:51:41.215149	\N
20	9876543210	consultation_summary.pdf	pdf	2025-05-20 20:53:44.679926	uploads/consultation_summary.pdf
21	9876543210	consultation_summary.pdf	pdf	2025-05-20 20:53:51.877458	uploads/consultation_summary.pdf
22	9876543210	consultation_summary.pdf	pdf	2025-05-20 20:57:49.011031	uploads/consultation_summary.pdf
23	9876543210	consultation_summary.pdf	pdf	2025-05-20 23:18:10.222453	uploads/consultation_summary.pdf
24	9876543210	consultation_summary.pdf	pdf	2025-05-20 23:24:28.236632	uploads/consultation_summary.pdf
25	9876543210	consultation_summary.pdf	pdf	2025-05-21 00:23:56.801726	uploads/consultation_summary.pdf
26	9876543210	consultation_summary.pdf	pdf	2025-05-21 00:30:42.020264	uploads/consultation_summary.pdf
27	9876543210	consultation_summary.pdf	pdf	2025-05-21 00:38:01.636304	uploads/consultation_summary.pdf
28	9876543210	consultation_summary.pdf	pdf	2025-05-21 00:43:08.965674	uploads/consultation_summary.pdf
29	9876543210	consultation_summary.pdf	pdf	2025-05-21 00:47:50.287201	uploads/consultation_summary.pdf
30	9876543210	consultation_summary.pdf	pdf	2025-05-21 00:51:20.002573	uploads/consultation_summary.pdf
31	9876543210	consultation_summary.pdf	pdf	2025-05-21 00:54:40.060246	uploads/consultation_summary.pdf
32	9876543210	consultation_summary.pdf	pdf	2025-05-21 01:14:00.57701	uploads/consultation_summary.pdf
33	9876543210	consultation_summary.pdf	pdf	2025-05-21 01:28:55.078833	uploads/consultation_summary.pdf
34	9876543210	consultation_summary.pdf	pdf	2025-05-21 01:40:49.73825	uploads/consultation_summary.pdf
35	9876543210	consultation_summary.pdf	pdf	2025-05-21 11:49:13.456733	uploads/consultation_summary.pdf
36	9876543210	consultation_summary.pdf	pdf	2025-05-21 12:10:53.401773	uploads/consultation_summary.pdf
37	9876543210	consultation_summary.pdf	pdf	2025-05-21 12:49:32.90147	uploads/consultation_summary.pdf
38	9876543210	consultation_summary.pdf	pdf	2025-05-21 12:52:54.290222	uploads/consultation_summary.pdf
39	9876543210	consultation_summary.pdf	pdf	2025-05-21 12:53:19.893697	uploads/consultation_summary.pdf
40	9876543210	consultation_summary.pdf	pdf	2025-05-21 13:59:58.103002	uploads/consultation_summary.pdf
41	9876543210	consultation_summary.pdf	pdf	2025-05-21 16:49:00.94071	uploads/consultation_summary.pdf
42	9876543210	consultation_summary.pdf	pdf	2025-05-21 17:44:20.470638	uploads/consultation_summary.pdf
43	9876543210	consultation_summary.pdf	pdf	2025-05-21 17:54:44.037809	uploads/consultation_summary.pdf
\.


--
-- Data for Name: investigations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.investigations (id, phone, test_name, status, requested_at, result_file, file_key) FROM stdin;
1	9876543210	Blood Test	requested	2025-05-12 14:21:17.048604	\N	\N
2	9876543210	Blood Test	requested	2025-05-12 23:27:33.192523	\N	\N
3	9876543210	Blood Test	requested	2025-05-15 17:43:18.183887	\N	\N
4	9876543210	Blood Test	requested	2025-05-15 17:53:51.280002	\N	\N
5	9876543210	Blood Test	requested	2025-05-15 18:01:51.349633	\N	\N
6	9876543210	Blood Test	requested	2025-05-15 18:05:34.488341	\N	\N
7	9876543210	Blood Test	requested	2025-05-15 18:14:05.323993	\N	\N
8	9876543210	Blood Test	requested	2025-05-15 18:19:48.082239	\N	\N
9	9876543210	Blood Test	fulfilled	2025-05-15 18:21:16.525115	blood_test_results.pdf	\N
10	9876543210	Blood Test	requested	2025-05-15 18:21:46.203417	\N	\N
11	9876543210	Blood Test	fulfilled	2025-05-15 18:23:07.832772	blood_test_results.pdf	\N
12	9876543210	Blood Test	requested	2025-05-15 18:32:48.949392	\N	\N
13	9876543210	Blood Test	pending	2025-05-15 18:32:49.859866	blood_test_results.pdf	\N
14	9876543210	Blood Test	requested	2025-05-15 19:24:50.046927	\N	\N
15	9876543210	Blood Test	pending	2025-05-15 19:24:50.957239	blood_test_results.pdf	\N
16	9876543210	Blood Test	requested	2025-05-16 01:15:55.263159	\N	\N
17	9876543210	Blood Test	pending	2025-05-16 01:15:56.157792	blood_test_results.pdf	\N
18	+919876543210	Blood Test	completed	2025-05-16 03:41:46.146074	blood_test_results.pdf	\N
19	9876543210	Blood Test	pending	2025-05-16 16:56:23.212431	blood_test_results.pdf	\N
20	9876543210	Blood Test	requested	2025-05-16 20:12:44.679228	\N	\N
21	9876543210	Blood Test	pending	2025-05-16 20:50:43.429753	blood_test_results.pdf	\N
22	9876543210	Blood Test	requested	2025-05-17 17:51:12.690525	\N	\N
23	9876543210	Blood Test	pending	2025-05-17 17:52:21.308314	blood_test_results.pdf	\N
24	9876543210	Blood Test	requested	2025-05-20 20:20:19.200609	\N	\N
25	9876543210	Blood Test	requested	2025-05-20 20:29:48.937732	\N	\N
26	9876543210	Blood Test	requested	2025-05-20 20:35:01.276188	\N	\N
27	9876543210	Blood Test	requested	2025-05-20 20:53:51.415789	\N	\N
28	9876543210	Blood Test	requested	2025-05-20 20:57:48.518684	\N	\N
29	9876543210	Blood Test	requested	2025-05-20 23:18:09.827397	\N	\N
30	9876543210	Blood Test	requested	2025-05-20 23:24:27.799854	\N	\N
36	+919876543210	Blood Test	requested	2025-05-21 00:51:15.487908	\N	\N
37	+919876543210	Blood Test	requested	2025-05-21 00:51:19.469537	\N	\N
38	+919876543210	Blood Test	requested	2025-05-21 00:54:39.620317	\N	\N
39	+919876543210	Blood Test	requested	2025-05-21 01:14:00.171628	\N	\N
40	+919876543210	Blood Test	pending	2025-05-21 01:15:46.879691	\N	blood_test_results.pdf
41	+919876543210	Blood Test	requested	2025-05-21 01:28:54.671998	\N	\N
42	+919876543210	Blood Test	pending	2025-05-21 01:28:55.613109	\N	blood_test_results.pdf
43	+919876543210	Blood Test	requested	2025-05-21 01:40:49.316464	\N	\N
44	+919876543210	Blood Test	pending	2025-05-21 01:40:50.254224	\N	blood_test_results.pdf
45	+919876543210	Blood Test	requested	2025-05-21 11:49:13.02326	\N	\N
46	+919876543210	Blood Test	pending	2025-05-21 11:49:14.001568	\N	blood_test_results.pdf
47	+919876543210	Blood Test	requested	2025-05-21 11:55:26.396129	\N	\N
48	+919876543210	Blood Test	pending	2025-05-21 11:55:27.417575	\N	blood_test_results.pdf
49	+919876543210	Blood Test	requested	2025-05-21 12:10:52.972689	\N	\N
50	+919876543210	Blood Test	pending	2025-05-21 12:10:53.806578	\N	blood_test_results.pdf
51	+919876543210	Blood Test	requested	2025-05-21 12:49:32.528886	\N	\N
52	+919876543210	Blood Test	pending	2025-05-21 12:49:33.250979	\N	blood_test_results.pdf
53	+919876543210	Blood Test	requested	2025-05-21 12:52:53.827588	\N	\N
54	+919876543210	Blood Test	pending	2025-05-21 12:52:54.784181	\N	blood_test_results.pdf
55	+919876543210	Blood Test	requested	2025-05-21 12:53:19.406216	\N	\N
56	+919876543210	Blood Test	pending	2025-05-21 12:53:20.40552	\N	blood_test_results.pdf
57	+919876543210	Blood Test	requested	2025-05-21 13:59:57.583291	\N	\N
58	+919876543210	Blood Test	pending	2025-05-21 13:59:58.668312	\N	blood_test_results.pdf
59	+919876543210	Blood Test	requested	2025-05-21 16:49:00.42206	\N	\N
60	+919876543210	Blood Test	pending	2025-05-21 16:49:01.43263	\N	blood_test_results.pdf
61	+919876543210	Blood Test	requested	2025-05-21 17:44:19.966359	\N	\N
62	+919876543210	Blood Test	pending	2025-05-21 17:44:21.071945	\N	blood_test_results.pdf
63	+919876543210	Blood Test	requested	2025-05-21 17:54:43.552539	\N	\N
64	+919876543210	Blood Test	pending	2025-05-21 17:54:44.470553	\N	blood_test_results.pdf
\.


--
-- Data for Name: pharmacy_orders; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.pharmacy_orders (id, phone, order_note, status, ordered_at, file_key, created_at) FROM stdin;
20	9876543210	Please prepare my order	requested	2025-05-20 20:20:19.450813	\N	2025-05-21 17:42:53.930929
21	9876543210	Please prepare my order	requested	2025-05-20 20:29:49.154757	\N	2025-05-21 17:42:53.930929
22	9876543210	Please prepare my order	requested	2025-05-20 20:35:01.509489	\N	2025-05-21 17:42:53.930929
23	9876543210	Please prepare my order	requested	2025-05-20 20:53:51.611971	\N	2025-05-21 17:42:53.930929
24	9876543210	Please prepare my order	requested	2025-05-20 20:57:48.76996	\N	2025-05-21 17:42:53.930929
25	9876543210	Please prepare my order	requested	2025-05-20 23:18:10.032741	\N	2025-05-21 17:42:53.930929
26	9876543210	Please prepare my order	requested	2025-05-20 23:24:28.047985	\N	2025-05-21 17:42:53.930929
33	+919876543210	Please prepare my order	requested	2025-05-21 00:54:35.418611	\N	2025-05-21 17:42:53.930929
34	+919876543210	Please prepare my order	requested	2025-05-21 00:54:39.854576	\N	2025-05-21 17:42:53.930929
35	+919876543210	Please prepare my order	requested	2025-05-21 01:14:00.387734	\N	2025-05-21 17:42:53.930929
36	+919876543210	Please prepare my order	requested	2025-05-21 01:28:54.88937	\N	2025-05-21 17:42:53.930929
37	+919876543210	Please prepare my order	requested	2025-05-21 01:40:49.553343	\N	2025-05-21 17:42:53.930929
38	+919876543210	Please prepare my order	requested	2025-05-21 11:49:13.271389	\N	2025-05-21 17:42:53.930929
39	+919876543210	Please prepare my order	requested	2025-05-21 12:10:53.170609	\N	2025-05-21 17:42:53.930929
40	+919876543210	Please prepare my order	requested	2025-05-21 12:49:32.712788	\N	2025-05-21 17:42:53.930929
41	+919876543210	Please prepare my order	requested	2025-05-21 12:52:54.059666	\N	2025-05-21 17:42:53.930929
42	+919876543210	Please prepare my order	requested	2025-05-21 12:53:19.659405	\N	2025-05-21 17:42:53.930929
43	+919876543210	Please prepare my order	requested	2025-05-21 13:59:57.829987	\N	2025-05-21 17:42:53.930929
44	+919876543210	Please prepare my order	requested	2025-05-21 16:49:00.672993	\N	2025-05-21 17:42:53.930929
45	+919876543210	Please prepare my order	requested	2025-05-21 17:44:20.202895	\N	2025-05-21 17:44:20.202895
46	+919876543210	Please prepare my order	requested	2025-05-21 17:54:43.80233	\N	2025-05-21 17:54:43.80233
16	+919876543210	Delivered to patient address	fulfilled	2025-05-16 03:41:55.583366	\N	2025-05-21 17:42:53.930929
\.


--
-- Data for Name: sos_alerts; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.sos_alerts (id, phone, latitude, longitude, created_at, ip_address) FROM stdin;
1	9876543210	12.9716	77.5946	2025-05-15 17:43:19.319461	\N
2	9876543210	12.9716	77.5946	2025-05-15 17:53:52.501811	\N
3	9876543210	12.9716	77.5946	2025-05-15 18:01:52.391975	\N
4	9876543210	12.9716	77.5946	2025-05-15 18:05:35.601884	\N
5	9876543210	12.9716	77.5946	2025-05-15 18:14:06.38676	\N
6	9876543210	12.9716	77.5946	2025-05-15 18:19:49.111563	\N
7	9876543210	12.9716	77.5946	2025-05-15 18:21:47.178438	\N
8	9876543210	12.9716	77.5946	2025-05-15 18:32:50.016934	\N
9	9876543210	12.9716	77.5946	2025-05-15 19:24:51.09549	\N
10	9876543210	12.9716	77.5946	2025-05-16 01:15:56.314327	\N
11	9876543210	12.9716	77.5946	2025-05-16 16:56:23.353592	\N
12	9876543210	12.9716	77.5946	2025-05-16 20:54:17.417473	\N
13	9876543210	12.9716	77.5946	2025-05-17 17:52:47.209506	\N
14	9876543210	12.9716	77.5946	2025-05-20 20:20:20.637513	\N
15	9876543210	12.9716	77.5946	2025-05-20 20:29:50.324678	\N
16	9876543210	12.9716	77.5946	2025-05-20 20:35:02.662852	\N
17	9876543210	12.9716	77.5946	2025-05-20 20:53:52.754046	\N
18	9876543210	12.9716	77.5946	2025-05-20 20:57:49.912793	\N
19	9876543210	12.9716	77.5946	2025-05-20 23:18:11.080784	\N
20	9876543210	12.9716	77.5946	2025-05-20 23:24:29.124108	\N
21	+919876543210	12.9716	77.5946	2025-05-21 01:40:11.28984	\N
22	+919876543210	12.9716	77.5946	2025-05-21 01:40:50.583198	\N
23	+919876543210	12.9716	77.5946	2025-05-21 11:49:14.311347	::1
24	+919876543210	12.9716	77.5946	2025-05-21 12:10:54.148105	::1
25	+919876543210	12.9716	77.5946	2025-05-21 12:49:33.660142	::1
26	+919876543210	12.9716	77.5946	2025-05-21 12:52:55.173416	::1
27	+919876543210	12.9716	77.5946	2025-05-21 12:53:20.780411	::1
28	+919876543210	12.9716	77.5946	2025-05-21 13:59:59.041083	::1
29	+919876543210	12.9716	77.5946	2025-05-21 16:49:01.809165	::1
30	+919876543210	12.9716	77.5946	2025-05-21 17:44:21.371721	::1
31	+919876543210	12.9716	77.5946	2025-05-21 17:54:44.826058	::1
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, phone, registered_at, name, gender, address, email, birthday, anniversary, profile_picture, uid) FROM stdin;
21	+919962074440	2025-05-16 21:08:45.877922	Subash Chandhar	male	Chennai, India	doc.chandhar@gmail.com	1989-03-18	2023-09-01	\N	29a1599f-4737-4bef-8706-d106dbbf6896
1	9876543210	2025-05-12 12:26:45.910216	John Doe	Male	123 Street	john@example.com	1990-01-01	2020-01-01	https://example.com/profile.jpg	836daa2d-8910-41de-a97a-cb9eb44b93b1
51	9962074440	2025-05-21 12:19:37.161279	Subash Chandhar	male	Chennai, India	doc.chandhar@gmail.com	1989-03-18	2023-09-01	\N	57545e82-eabe-45e6-bcfd-72ca778accd8
12	+919876543210	2025-05-16 00:37:21.437946	John Doe	male	123 Street	john@example.com	1990-01-01	2020-01-01	https://example.com/profile.jpg	505929da-13c9-4132-9140-5f63e8f6d300
\.


--
-- Name: appointments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.appointments_id_seq', 43, true);


--
-- Name: consultations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.consultations_id_seq', 29, true);


--
-- Name: departments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.departments_id_seq', 44, true);


--
-- Name: doctors_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.doctors_id_seq', 43, true);


--
-- Name: feedback_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.feedback_id_seq', 36, true);


--
-- Name: file_metadata_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.file_metadata_id_seq', 2, true);


--
-- Name: health_records_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.health_records_id_seq', 43, true);


--
-- Name: investigations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.investigations_id_seq', 64, true);


--
-- Name: pharmacy_orders_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.pharmacy_orders_id_seq', 46, true);


--
-- Name: sos_alerts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.sos_alerts_id_seq', 31, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.users_id_seq', 59, true);


--
-- Name: appointments appointments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.appointments
    ADD CONSTRAINT appointments_pkey PRIMARY KEY (id);


--
-- Name: consultations consultations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.consultations
    ADD CONSTRAINT consultations_pkey PRIMARY KEY (id);


--
-- Name: departments departments_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_name_key UNIQUE (name);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: doctors doctors_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_pkey PRIMARY KEY (id);


--
-- Name: feedback feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);


--
-- Name: file_metadata file_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.file_metadata
    ADD CONSTRAINT file_metadata_pkey PRIMARY KEY (id);


--
-- Name: file_metadata file_metadata_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.file_metadata
    ADD CONSTRAINT file_metadata_storage_key_key UNIQUE (storage_key);


--
-- Name: health_records health_records_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.health_records
    ADD CONSTRAINT health_records_pkey PRIMARY KEY (id);


--
-- Name: investigations investigations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.investigations
    ADD CONSTRAINT investigations_pkey PRIMARY KEY (id);


--
-- Name: pharmacy_orders pharmacy_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.pharmacy_orders
    ADD CONSTRAINT pharmacy_orders_pkey PRIMARY KEY (id);


--
-- Name: sos_alerts sos_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sos_alerts
    ADD CONSTRAINT sos_alerts_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_uid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_uid_key UNIQUE (uid);


--
-- Name: doctors fk_doctors_department_id; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT fk_doctors_department_id FOREIGN KEY (department_id) REFERENCES public.departments(id);


--
-- PostgreSQL database dump complete
--

