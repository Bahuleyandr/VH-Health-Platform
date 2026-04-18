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
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
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
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
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
    result_file text
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
    ordered_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
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
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
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
\.


--
-- Data for Name: consultations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.consultations (id, phone, file_name, file_type, created_at) FROM stdin;
1	9876543210	consultation_summary.pdf	pdf	2025-05-15 17:43:19.041364
2	9876543210	consultation_summary.pdf	pdf	2025-05-15 17:53:52.155793
3	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:01:52.089536
4	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:05:35.34968
5	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:14:06.138065
6	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:19:48.862431
7	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:21:47.016428
8	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:32:49.797513
9	9876543210	consultation_summary.pdf	pdf	2025-05-15 19:24:50.894905
10	9876543210	consultation_summary.pdf	pdf	2025-05-16 01:15:56.094634
11	9876543210	consultation_summary.pdf	pdf	2025-05-16 16:56:23.149053
12	9876543210	consultation_summary.pdf	pdf	2025-05-16 20:50:21.100497
13	9876543210	consultation_summary.pdf	pdf	2025-05-17 17:52:16.792626
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
\.


--
-- Data for Name: file_metadata; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.file_metadata (id, file_name, file_type, storage_key, storage_url, file_size, uploaded_by, uploaded_at) FROM stdin;
\.


--
-- Data for Name: health_records; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.health_records (id, phone, file_name, file_type, created_at) FROM stdin;
1	9876543210	prescription_may15.pdf	prescription	2025-05-12 13:01:12.48381
2	9876543210	prescription_may15.pdf	prescription	2025-05-12 14:21:01.908772
3	9876543210	prescription_may15.pdf	prescription	2025-05-12 23:27:01.449493
4	9876543210	consultation_summary.pdf	pdf	2025-05-15 17:43:18.496546
5	9876543210	consultation_summary.pdf	pdf	2025-05-15 17:53:51.597417
6	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:01:51.611445
7	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:05:34.803659
8	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:14:05.670954
9	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:19:48.363912
10	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:21:46.546568
11	9876543210	consultation_summary.pdf	pdf	2025-05-15 18:32:49.263759
12	9876543210	consultation_summary.pdf	pdf	2025-05-15 19:24:50.330709
13	9876543210	consultation_summary.pdf	pdf	2025-05-16 01:15:55.546634
14	+919876543210	record_test.pdf	application/pdf	2025-05-16 03:41:35.083484
15	9876543210	consultation_summary.pdf	pdf	2025-05-16 20:33:37.761672
16	9876543210	consultation_summary.pdf	pdf	2025-05-17 17:51:41.215149
\.


--
-- Data for Name: investigations; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.investigations (id, phone, test_name, status, requested_at, result_file) FROM stdin;
1	9876543210	Blood Test	requested	2025-05-12 14:21:17.048604	\N
2	9876543210	Blood Test	requested	2025-05-12 23:27:33.192523	\N
3	9876543210	Blood Test	requested	2025-05-15 17:43:18.183887	\N
4	9876543210	Blood Test	requested	2025-05-15 17:53:51.280002	\N
5	9876543210	Blood Test	requested	2025-05-15 18:01:51.349633	\N
6	9876543210	Blood Test	requested	2025-05-15 18:05:34.488341	\N
7	9876543210	Blood Test	requested	2025-05-15 18:14:05.323993	\N
8	9876543210	Blood Test	requested	2025-05-15 18:19:48.082239	\N
9	9876543210	Blood Test	fulfilled	2025-05-15 18:21:16.525115	blood_test_results.pdf
10	9876543210	Blood Test	requested	2025-05-15 18:21:46.203417	\N
11	9876543210	Blood Test	fulfilled	2025-05-15 18:23:07.832772	blood_test_results.pdf
12	9876543210	Blood Test	requested	2025-05-15 18:32:48.949392	\N
13	9876543210	Blood Test	pending	2025-05-15 18:32:49.859866	blood_test_results.pdf
14	9876543210	Blood Test	requested	2025-05-15 19:24:50.046927	\N
15	9876543210	Blood Test	pending	2025-05-15 19:24:50.957239	blood_test_results.pdf
16	9876543210	Blood Test	requested	2025-05-16 01:15:55.263159	\N
17	9876543210	Blood Test	pending	2025-05-16 01:15:56.157792	blood_test_results.pdf
18	+919876543210	Blood Test	completed	2025-05-16 03:41:46.146074	blood_test_results.pdf
19	9876543210	Blood Test	pending	2025-05-16 16:56:23.212431	blood_test_results.pdf
20	9876543210	Blood Test	requested	2025-05-16 20:12:44.679228	\N
21	9876543210	Blood Test	pending	2025-05-16 20:50:43.429753	blood_test_results.pdf
22	9876543210	Blood Test	requested	2025-05-17 17:51:12.690525	\N
23	9876543210	Blood Test	pending	2025-05-17 17:52:21.308314	blood_test_results.pdf
\.


--
-- Data for Name: pharmacy_orders; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.pharmacy_orders (id, phone, order_note, status, ordered_at) FROM stdin;
2	9876543210	Please deliver my BP tablets.	requested	2025-05-12 14:18:48.635641
3	9876543210	Please deliver my BP tablets.	requested	2025-05-12 14:21:27.749557
4	9876543210	Please deliver my BP tablets.	requested	2025-05-12 23:23:40.347889
5	9876543210	Please deliver my BP tablets.	requested	2025-05-12 23:28:04.407984
6	9876543210	Please prepare my order	requested	2025-05-15 17:43:18.358363
7	9876543210	Please prepare my order	requested	2025-05-15 17:53:51.454547
8	9876543210	Please prepare my order	requested	2025-05-15 18:01:51.504675
9	9876543210	Please prepare my order	requested	2025-05-15 18:05:34.630643
10	9876543210	Please prepare my order	requested	2025-05-15 18:14:05.496332
11	9876543210	Please prepare my order	requested	2025-05-15 18:19:48.223625
12	9876543210	Please prepare my order	requested	2025-05-15 18:21:46.389756
13	9876543210	Please prepare my order	requested	2025-05-15 18:32:49.122726
14	9876543210	Please prepare my order	requested	2025-05-15 19:24:50.172459
15	9876543210	Please prepare my order	requested	2025-05-16 01:15:55.407097
16	+919876543210	Paracetamol 500mg x 10 tablets	completed	2025-05-16 03:41:55.583366
17	9876543210	Please prepare my order	requested	2025-05-16 20:19:37.076453
18	9876543210	Please prepare my order	requested	2025-05-16 20:19:51.689568
19	9876543210	Please prepare my order	requested	2025-05-17 17:51:26.465512
1	9876543210	Delivered to patient address	fulfilled	2025-05-12 13:12:01.656808
\.


--
-- Data for Name: sos_alerts; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.sos_alerts (id, phone, latitude, longitude, created_at) FROM stdin;
1	9876543210	12.9716	77.5946	2025-05-15 17:43:19.319461
2	9876543210	12.9716	77.5946	2025-05-15 17:53:52.501811
3	9876543210	12.9716	77.5946	2025-05-15 18:01:52.391975
4	9876543210	12.9716	77.5946	2025-05-15 18:05:35.601884
5	9876543210	12.9716	77.5946	2025-05-15 18:14:06.38676
6	9876543210	12.9716	77.5946	2025-05-15 18:19:49.111563
7	9876543210	12.9716	77.5946	2025-05-15 18:21:47.178438
8	9876543210	12.9716	77.5946	2025-05-15 18:32:50.016934
9	9876543210	12.9716	77.5946	2025-05-15 19:24:51.09549
10	9876543210	12.9716	77.5946	2025-05-16 01:15:56.314327
11	9876543210	12.9716	77.5946	2025-05-16 16:56:23.353592
12	9876543210	12.9716	77.5946	2025-05-16 20:54:17.417473
13	9876543210	12.9716	77.5946	2025-05-17 17:52:47.209506
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, phone, registered_at, name, gender, address, email, birthday, anniversary, profile_picture, uid) FROM stdin;
12	+919876543210	2025-05-16 00:37:21.437946	John Doe	male	Chennai, India	john@example.com	1990-01-01	2015-01-01	\N	505929da-13c9-4132-9140-5f63e8f6d300
21	+919962074440	2025-05-16 21:08:45.877922	Subash Chandhar	male	Chennai, India	doc.chandhar@gmail.com	1989-03-18	2023-09-01	\N	29a1599f-4737-4bef-8706-d106dbbf6896
1	9876543210	2025-05-12 12:26:45.910216	John Doe	Male	123 Street	john@example.com	1990-01-01	2020-01-01	https://example.com/profile.jpg	836daa2d-8910-41de-a97a-cb9eb44b93b1
\.


--
-- Name: appointments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.appointments_id_seq', 14, true);


--
-- Name: consultations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.consultations_id_seq', 13, true);


--
-- Name: departments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.departments_id_seq', 15, true);


--
-- Name: doctors_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.doctors_id_seq', 14, true);


--
-- Name: feedback_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.feedback_id_seq', 12, true);


--
-- Name: file_metadata_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.file_metadata_id_seq', 1, false);


--
-- Name: health_records_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.health_records_id_seq', 16, true);


--
-- Name: investigations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.investigations_id_seq', 23, true);


--
-- Name: pharmacy_orders_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.pharmacy_orders_id_seq', 19, true);


--
-- Name: sos_alerts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.sos_alerts_id_seq', 13, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.users_id_seq', 22, true);


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

