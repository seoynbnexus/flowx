--
-- PostgreSQL database dump
--

\restrict aQU7qPXIYSrbIbaw6ZVIWt0apajg3xZ9g5m0WuNONmbEEWxRM0bUnpsmeth7zUf

-- Dumped from database version 18.4 (Homebrew)
-- Dumped by pg_dump version 18.4 (Homebrew)

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
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: audit_entity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audit_entity_type AS ENUM (
    'user',
    'role',
    'oauth_account',
    'session'
);


--
-- Name: status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.status AS ENUM (
    'active',
    'inactive',
    'blocked',
    'pending'
);


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    status public.status DEFAULT 'pending'::public.status NOT NULL,
    email_verified_at timestamp with time zone,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: active_users; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.active_users AS
 SELECT id,
    email,
    status,
    email_verified_at,
    last_login_at,
    created_at,
    updated_at,
    deleted_at
   FROM public.users
  WHERE (deleted_at IS NULL);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_id uuid,
    entity_type public.audit_entity_type,
    entity_id uuid,
    action character varying(100),
    old_values jsonb,
    new_values jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (created_at);


--
-- Name: audit_logs_2026_06; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs_2026_06 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT audit_logs_id_not_null NOT NULL,
    actor_id uuid,
    entity_type public.audit_entity_type,
    entity_id uuid,
    action character varying(100),
    old_values jsonb,
    new_values jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT audit_logs_created_at_not_null NOT NULL
);


--
-- Name: audit_logs_2026_07; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs_2026_07 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT audit_logs_id_not_null NOT NULL,
    actor_id uuid,
    entity_type public.audit_entity_type,
    entity_id uuid,
    action character varying(100),
    old_values jsonb,
    new_values jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT audit_logs_created_at_not_null NOT NULL
);


--
-- Name: audit_logs_2026_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs_2026_08 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT audit_logs_id_not_null NOT NULL,
    actor_id uuid,
    entity_type public.audit_entity_type,
    entity_id uuid,
    action character varying(100),
    old_values jsonb,
    new_values jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT audit_logs_created_at_not_null NOT NULL
);


--
-- Name: audit_logs_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs_2026_09 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT audit_logs_id_not_null NOT NULL,
    actor_id uuid,
    entity_type public.audit_entity_type,
    entity_id uuid,
    action character varying(100),
    old_values jsonb,
    new_values jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT audit_logs_created_at_not_null NOT NULL
);


--
-- Name: audit_logs_2026_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs_2026_10 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT audit_logs_id_not_null NOT NULL,
    actor_id uuid,
    entity_type public.audit_entity_type,
    entity_id uuid,
    action character varying(100),
    old_values jsonb,
    new_values jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT audit_logs_created_at_not_null NOT NULL
);


--
-- Name: audit_logs_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs_2026_11 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT audit_logs_id_not_null NOT NULL,
    actor_id uuid,
    entity_type public.audit_entity_type,
    entity_id uuid,
    action character varying(100),
    old_values jsonb,
    new_values jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT audit_logs_created_at_not_null NOT NULL
);


--
-- Name: audit_logs_2026_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs_2026_12 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT audit_logs_id_not_null NOT NULL,
    actor_id uuid,
    entity_type public.audit_entity_type,
    entity_id uuid,
    action character varying(100),
    old_values jsonb,
    new_values jsonb,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT audit_logs_created_at_not_null NOT NULL
);


--
-- Name: auth_login_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    provider_id uuid,
    login_method character varying(50),
    ip_address inet,
    user_agent text,
    success boolean,
    created_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (created_at);


--
-- Name: auth_login_history_2026_06; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_history_2026_06 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT auth_login_history_id_not_null NOT NULL,
    user_id uuid,
    provider_id uuid,
    login_method character varying(50),
    ip_address inet,
    user_agent text,
    success boolean,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT auth_login_history_created_at_not_null NOT NULL
);


--
-- Name: auth_login_history_2026_07; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_history_2026_07 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT auth_login_history_id_not_null NOT NULL,
    user_id uuid,
    provider_id uuid,
    login_method character varying(50),
    ip_address inet,
    user_agent text,
    success boolean,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT auth_login_history_created_at_not_null NOT NULL
);


--
-- Name: auth_login_history_2026_08; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_history_2026_08 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT auth_login_history_id_not_null NOT NULL,
    user_id uuid,
    provider_id uuid,
    login_method character varying(50),
    ip_address inet,
    user_agent text,
    success boolean,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT auth_login_history_created_at_not_null NOT NULL
);


--
-- Name: auth_login_history_2026_09; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_history_2026_09 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT auth_login_history_id_not_null NOT NULL,
    user_id uuid,
    provider_id uuid,
    login_method character varying(50),
    ip_address inet,
    user_agent text,
    success boolean,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT auth_login_history_created_at_not_null NOT NULL
);


--
-- Name: auth_login_history_2026_10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_history_2026_10 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT auth_login_history_id_not_null NOT NULL,
    user_id uuid,
    provider_id uuid,
    login_method character varying(50),
    ip_address inet,
    user_agent text,
    success boolean,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT auth_login_history_created_at_not_null NOT NULL
);


--
-- Name: auth_login_history_2026_11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_history_2026_11 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT auth_login_history_id_not_null NOT NULL,
    user_id uuid,
    provider_id uuid,
    login_method character varying(50),
    ip_address inet,
    user_agent text,
    success boolean,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT auth_login_history_created_at_not_null NOT NULL
);


--
-- Name: auth_login_history_2026_12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_login_history_2026_12 (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT auth_login_history_id_not_null NOT NULL,
    user_id uuid,
    provider_id uuid,
    login_method character varying(50),
    ip_address inet,
    user_agent text,
    success boolean,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT auth_login_history_created_at_not_null NOT NULL
);


--
-- Name: email_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: oauth_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_user_id character varying(255) NOT NULL,
    provider_email character varying(255),
    provider_username character varying(255),
    metadata jsonb DEFAULT '{}'::jsonb,
    linked_at timestamp with time zone DEFAULT now()
);


--
-- Name: oauth_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    oauth_account_id uuid NOT NULL,
    encrypted_access_token text,
    encrypted_refresh_token text,
    encrypted_id_token text,
    token_type character varying(50),
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: password_resets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_resets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(100) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    module character varying(100) NOT NULL,
    is_system boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: pgmigrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pgmigrations (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    run_on timestamp without time zone NOT NULL
);


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pgmigrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pgmigrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pgmigrations_id_seq OWNED BY public.pgmigrations.id;


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now()
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    is_system boolean DEFAULT false,
    is_super_admin boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_passwords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_passwords (
    user_id uuid NOT NULL,
    password_hash text NOT NULL,
    password_changed_at timestamp with time zone,
    failed_attempts integer DEFAULT 0,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    first_name character varying(100),
    last_name character varying(100),
    phone character varying(50),
    avatar_url text,
    country_code character(2) DEFAULT 'IN'::bpchar,
    city character varying(100),
    timezone character varying(100),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    refresh_token_hash text NOT NULL,
    device_name character varying(255),
    ip_address inet,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs_2026_06; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ATTACH PARTITION public.audit_logs_2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+05:30') TO ('2026-07-01 00:00:00+05:30');


--
-- Name: audit_logs_2026_07; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ATTACH PARTITION public.audit_logs_2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+05:30') TO ('2026-08-01 00:00:00+05:30');


--
-- Name: audit_logs_2026_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ATTACH PARTITION public.audit_logs_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+05:30') TO ('2026-09-01 00:00:00+05:30');


--
-- Name: audit_logs_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ATTACH PARTITION public.audit_logs_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+05:30') TO ('2026-10-01 00:00:00+05:30');


--
-- Name: audit_logs_2026_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ATTACH PARTITION public.audit_logs_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00+05:30') TO ('2026-11-01 00:00:00+05:30');


--
-- Name: audit_logs_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ATTACH PARTITION public.audit_logs_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+05:30') TO ('2026-12-01 00:00:00+05:30');


--
-- Name: audit_logs_2026_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ATTACH PARTITION public.audit_logs_2026_12 FOR VALUES FROM ('2026-12-01 00:00:00+05:30') TO ('2027-01-01 00:00:00+05:30');


--
-- Name: auth_login_history_2026_06; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history ATTACH PARTITION public.auth_login_history_2026_06 FOR VALUES FROM ('2026-06-01 00:00:00+05:30') TO ('2026-07-01 00:00:00+05:30');


--
-- Name: auth_login_history_2026_07; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history ATTACH PARTITION public.auth_login_history_2026_07 FOR VALUES FROM ('2026-07-01 00:00:00+05:30') TO ('2026-08-01 00:00:00+05:30');


--
-- Name: auth_login_history_2026_08; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history ATTACH PARTITION public.auth_login_history_2026_08 FOR VALUES FROM ('2026-08-01 00:00:00+05:30') TO ('2026-09-01 00:00:00+05:30');


--
-- Name: auth_login_history_2026_09; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history ATTACH PARTITION public.auth_login_history_2026_09 FOR VALUES FROM ('2026-09-01 00:00:00+05:30') TO ('2026-10-01 00:00:00+05:30');


--
-- Name: auth_login_history_2026_10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history ATTACH PARTITION public.auth_login_history_2026_10 FOR VALUES FROM ('2026-10-01 00:00:00+05:30') TO ('2026-11-01 00:00:00+05:30');


--
-- Name: auth_login_history_2026_11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history ATTACH PARTITION public.auth_login_history_2026_11 FOR VALUES FROM ('2026-11-01 00:00:00+05:30') TO ('2026-12-01 00:00:00+05:30');


--
-- Name: auth_login_history_2026_12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history ATTACH PARTITION public.auth_login_history_2026_12 FOR VALUES FROM ('2026-12-01 00:00:00+05:30') TO ('2027-01-01 00:00:00+05:30');


--
-- Name: pgmigrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations ALTER COLUMN id SET DEFAULT nextval('public.pgmigrations_id_seq'::regclass);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id, created_at);


--
-- Name: audit_logs_2026_06 audit_logs_2026_06_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs_2026_06
    ADD CONSTRAINT audit_logs_2026_06_pkey PRIMARY KEY (id, created_at);


--
-- Name: audit_logs_2026_07 audit_logs_2026_07_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs_2026_07
    ADD CONSTRAINT audit_logs_2026_07_pkey PRIMARY KEY (id, created_at);


--
-- Name: audit_logs_2026_08 audit_logs_2026_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs_2026_08
    ADD CONSTRAINT audit_logs_2026_08_pkey PRIMARY KEY (id, created_at);


--
-- Name: audit_logs_2026_09 audit_logs_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs_2026_09
    ADD CONSTRAINT audit_logs_2026_09_pkey PRIMARY KEY (id, created_at);


--
-- Name: audit_logs_2026_10 audit_logs_2026_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs_2026_10
    ADD CONSTRAINT audit_logs_2026_10_pkey PRIMARY KEY (id, created_at);


--
-- Name: audit_logs_2026_11 audit_logs_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs_2026_11
    ADD CONSTRAINT audit_logs_2026_11_pkey PRIMARY KEY (id, created_at);


--
-- Name: audit_logs_2026_12 audit_logs_2026_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs_2026_12
    ADD CONSTRAINT audit_logs_2026_12_pkey PRIMARY KEY (id, created_at);


--
-- Name: auth_login_history auth_login_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history
    ADD CONSTRAINT auth_login_history_pkey PRIMARY KEY (id, created_at);


--
-- Name: auth_login_history_2026_06 auth_login_history_2026_06_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history_2026_06
    ADD CONSTRAINT auth_login_history_2026_06_pkey PRIMARY KEY (id, created_at);


--
-- Name: auth_login_history_2026_07 auth_login_history_2026_07_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history_2026_07
    ADD CONSTRAINT auth_login_history_2026_07_pkey PRIMARY KEY (id, created_at);


--
-- Name: auth_login_history_2026_08 auth_login_history_2026_08_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history_2026_08
    ADD CONSTRAINT auth_login_history_2026_08_pkey PRIMARY KEY (id, created_at);


--
-- Name: auth_login_history_2026_09 auth_login_history_2026_09_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history_2026_09
    ADD CONSTRAINT auth_login_history_2026_09_pkey PRIMARY KEY (id, created_at);


--
-- Name: auth_login_history_2026_10 auth_login_history_2026_10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history_2026_10
    ADD CONSTRAINT auth_login_history_2026_10_pkey PRIMARY KEY (id, created_at);


--
-- Name: auth_login_history_2026_11 auth_login_history_2026_11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history_2026_11
    ADD CONSTRAINT auth_login_history_2026_11_pkey PRIMARY KEY (id, created_at);


--
-- Name: auth_login_history_2026_12 auth_login_history_2026_12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_login_history_2026_12
    ADD CONSTRAINT auth_login_history_2026_12_pkey PRIMARY KEY (id, created_at);


--
-- Name: email_verifications email_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verifications
    ADD CONSTRAINT email_verifications_pkey PRIMARY KEY (id);


--
-- Name: email_verifications email_verifications_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verifications
    ADD CONSTRAINT email_verifications_token_hash_key UNIQUE (token_hash);


--
-- Name: oauth_accounts oauth_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_accounts
    ADD CONSTRAINT oauth_accounts_pkey PRIMARY KEY (id);


--
-- Name: oauth_providers oauth_providers_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_providers
    ADD CONSTRAINT oauth_providers_code_key UNIQUE (code);


--
-- Name: oauth_providers oauth_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_providers
    ADD CONSTRAINT oauth_providers_pkey PRIMARY KEY (id);


--
-- Name: oauth_tokens oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_code_key UNIQUE (code);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: pgmigrations pgmigrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pgmigrations
    ADD CONSTRAINT pgmigrations_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);


--
-- Name: roles roles_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_code_key UNIQUE (code);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: oauth_accounts uq_oauth_provider_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_accounts
    ADD CONSTRAINT uq_oauth_provider_user UNIQUE (provider_id, provider_user_id);


--
-- Name: role_permissions uq_role_permissions; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT uq_role_permissions UNIQUE (role_id, permission_id);


--
-- Name: user_roles uq_user_roles; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT uq_user_roles UNIQUE (user_id, role_id);


--
-- Name: user_passwords user_passwords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_passwords
    ADD CONSTRAINT user_passwords_pkey PRIMARY KEY (user_id);


--
-- Name: user_profiles user_profiles_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_phone_key UNIQUE (phone);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);


--
-- Name: user_profiles user_profiles_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_user_id_key UNIQUE (user_id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (id);


--
-- Name: user_sessions user_sessions_refresh_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_refresh_token_hash_key UNIQUE (refresh_token_hash);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_audit_logs_actor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_actor_id ON ONLY public.audit_logs USING btree (actor_id);


--
-- Name: audit_logs_2026_06_actor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_06_actor_id_idx ON public.audit_logs_2026_06 USING btree (actor_id);


--
-- Name: idx_audit_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_created_at ON ONLY public.audit_logs USING btree (created_at DESC);


--
-- Name: audit_logs_2026_06_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_06_created_at_idx ON public.audit_logs_2026_06 USING btree (created_at DESC);


--
-- Name: idx_audit_logs_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_entity ON ONLY public.audit_logs USING btree (entity_type, entity_id);


--
-- Name: audit_logs_2026_06_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_06_entity_type_entity_id_idx ON public.audit_logs_2026_06 USING btree (entity_type, entity_id);


--
-- Name: idx_audit_logs_new_values_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_new_values_gin ON ONLY public.audit_logs USING gin (new_values);


--
-- Name: audit_logs_2026_06_new_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_06_new_values_idx ON public.audit_logs_2026_06 USING gin (new_values);


--
-- Name: idx_audit_logs_old_values_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_logs_old_values_gin ON ONLY public.audit_logs USING gin (old_values);


--
-- Name: audit_logs_2026_06_old_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_06_old_values_idx ON public.audit_logs_2026_06 USING gin (old_values);


--
-- Name: audit_logs_2026_07_actor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_07_actor_id_idx ON public.audit_logs_2026_07 USING btree (actor_id);


--
-- Name: audit_logs_2026_07_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_07_created_at_idx ON public.audit_logs_2026_07 USING btree (created_at DESC);


--
-- Name: audit_logs_2026_07_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_07_entity_type_entity_id_idx ON public.audit_logs_2026_07 USING btree (entity_type, entity_id);


--
-- Name: audit_logs_2026_07_new_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_07_new_values_idx ON public.audit_logs_2026_07 USING gin (new_values);


--
-- Name: audit_logs_2026_07_old_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_07_old_values_idx ON public.audit_logs_2026_07 USING gin (old_values);


--
-- Name: audit_logs_2026_08_actor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_08_actor_id_idx ON public.audit_logs_2026_08 USING btree (actor_id);


--
-- Name: audit_logs_2026_08_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_08_created_at_idx ON public.audit_logs_2026_08 USING btree (created_at DESC);


--
-- Name: audit_logs_2026_08_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_08_entity_type_entity_id_idx ON public.audit_logs_2026_08 USING btree (entity_type, entity_id);


--
-- Name: audit_logs_2026_08_new_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_08_new_values_idx ON public.audit_logs_2026_08 USING gin (new_values);


--
-- Name: audit_logs_2026_08_old_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_08_old_values_idx ON public.audit_logs_2026_08 USING gin (old_values);


--
-- Name: audit_logs_2026_09_actor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_09_actor_id_idx ON public.audit_logs_2026_09 USING btree (actor_id);


--
-- Name: audit_logs_2026_09_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_09_created_at_idx ON public.audit_logs_2026_09 USING btree (created_at DESC);


--
-- Name: audit_logs_2026_09_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_09_entity_type_entity_id_idx ON public.audit_logs_2026_09 USING btree (entity_type, entity_id);


--
-- Name: audit_logs_2026_09_new_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_09_new_values_idx ON public.audit_logs_2026_09 USING gin (new_values);


--
-- Name: audit_logs_2026_09_old_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_09_old_values_idx ON public.audit_logs_2026_09 USING gin (old_values);


--
-- Name: audit_logs_2026_10_actor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_10_actor_id_idx ON public.audit_logs_2026_10 USING btree (actor_id);


--
-- Name: audit_logs_2026_10_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_10_created_at_idx ON public.audit_logs_2026_10 USING btree (created_at DESC);


--
-- Name: audit_logs_2026_10_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_10_entity_type_entity_id_idx ON public.audit_logs_2026_10 USING btree (entity_type, entity_id);


--
-- Name: audit_logs_2026_10_new_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_10_new_values_idx ON public.audit_logs_2026_10 USING gin (new_values);


--
-- Name: audit_logs_2026_10_old_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_10_old_values_idx ON public.audit_logs_2026_10 USING gin (old_values);


--
-- Name: audit_logs_2026_11_actor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_11_actor_id_idx ON public.audit_logs_2026_11 USING btree (actor_id);


--
-- Name: audit_logs_2026_11_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_11_created_at_idx ON public.audit_logs_2026_11 USING btree (created_at DESC);


--
-- Name: audit_logs_2026_11_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_11_entity_type_entity_id_idx ON public.audit_logs_2026_11 USING btree (entity_type, entity_id);


--
-- Name: audit_logs_2026_11_new_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_11_new_values_idx ON public.audit_logs_2026_11 USING gin (new_values);


--
-- Name: audit_logs_2026_11_old_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_11_old_values_idx ON public.audit_logs_2026_11 USING gin (old_values);


--
-- Name: audit_logs_2026_12_actor_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_12_actor_id_idx ON public.audit_logs_2026_12 USING btree (actor_id);


--
-- Name: audit_logs_2026_12_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_12_created_at_idx ON public.audit_logs_2026_12 USING btree (created_at DESC);


--
-- Name: audit_logs_2026_12_entity_type_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_12_entity_type_entity_id_idx ON public.audit_logs_2026_12 USING btree (entity_type, entity_id);


--
-- Name: audit_logs_2026_12_new_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_12_new_values_idx ON public.audit_logs_2026_12 USING gin (new_values);


--
-- Name: audit_logs_2026_12_old_values_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_2026_12_old_values_idx ON public.audit_logs_2026_12 USING gin (old_values);


--
-- Name: idx_auth_login_history_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_login_history_created_at ON ONLY public.auth_login_history USING btree (created_at DESC);


--
-- Name: auth_login_history_2026_06_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_06_created_at_idx ON public.auth_login_history_2026_06 USING btree (created_at DESC);


--
-- Name: idx_auth_login_history_provider_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_login_history_provider_user_created ON ONLY public.auth_login_history USING btree (provider_id, user_id, created_at);


--
-- Name: auth_login_history_2026_06_provider_id_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_06_provider_id_user_id_created_at_idx ON public.auth_login_history_2026_06 USING btree (provider_id, user_id, created_at);


--
-- Name: idx_auth_login_history_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_auth_login_history_user ON ONLY public.auth_login_history USING btree (user_id);


--
-- Name: auth_login_history_2026_06_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_06_user_id_idx ON public.auth_login_history_2026_06 USING btree (user_id);


--
-- Name: auth_login_history_2026_07_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_07_created_at_idx ON public.auth_login_history_2026_07 USING btree (created_at DESC);


--
-- Name: auth_login_history_2026_07_provider_id_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_07_provider_id_user_id_created_at_idx ON public.auth_login_history_2026_07 USING btree (provider_id, user_id, created_at);


--
-- Name: auth_login_history_2026_07_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_07_user_id_idx ON public.auth_login_history_2026_07 USING btree (user_id);


--
-- Name: auth_login_history_2026_08_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_08_created_at_idx ON public.auth_login_history_2026_08 USING btree (created_at DESC);


--
-- Name: auth_login_history_2026_08_provider_id_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_08_provider_id_user_id_created_at_idx ON public.auth_login_history_2026_08 USING btree (provider_id, user_id, created_at);


--
-- Name: auth_login_history_2026_08_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_08_user_id_idx ON public.auth_login_history_2026_08 USING btree (user_id);


--
-- Name: auth_login_history_2026_09_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_09_created_at_idx ON public.auth_login_history_2026_09 USING btree (created_at DESC);


--
-- Name: auth_login_history_2026_09_provider_id_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_09_provider_id_user_id_created_at_idx ON public.auth_login_history_2026_09 USING btree (provider_id, user_id, created_at);


--
-- Name: auth_login_history_2026_09_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_09_user_id_idx ON public.auth_login_history_2026_09 USING btree (user_id);


--
-- Name: auth_login_history_2026_10_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_10_created_at_idx ON public.auth_login_history_2026_10 USING btree (created_at DESC);


--
-- Name: auth_login_history_2026_10_provider_id_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_10_provider_id_user_id_created_at_idx ON public.auth_login_history_2026_10 USING btree (provider_id, user_id, created_at);


--
-- Name: auth_login_history_2026_10_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_10_user_id_idx ON public.auth_login_history_2026_10 USING btree (user_id);


--
-- Name: auth_login_history_2026_11_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_11_created_at_idx ON public.auth_login_history_2026_11 USING btree (created_at DESC);


--
-- Name: auth_login_history_2026_11_provider_id_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_11_provider_id_user_id_created_at_idx ON public.auth_login_history_2026_11 USING btree (provider_id, user_id, created_at);


--
-- Name: auth_login_history_2026_11_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_11_user_id_idx ON public.auth_login_history_2026_11 USING btree (user_id);


--
-- Name: auth_login_history_2026_12_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_12_created_at_idx ON public.auth_login_history_2026_12 USING btree (created_at DESC);


--
-- Name: auth_login_history_2026_12_provider_id_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_12_provider_id_user_id_created_at_idx ON public.auth_login_history_2026_12 USING btree (provider_id, user_id, created_at);


--
-- Name: auth_login_history_2026_12_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_login_history_2026_12_user_id_idx ON public.auth_login_history_2026_12 USING btree (user_id);


--
-- Name: idx_email_verification_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_verification_user_id ON public.email_verifications USING btree (user_id);


--
-- Name: idx_email_verifications_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_verifications_expires_at ON public.email_verifications USING btree (expires_at);


--
-- Name: idx_oauth_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_account_id ON public.oauth_tokens USING btree (oauth_account_id);


--
-- Name: idx_oauth_account_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_account_user_id ON public.oauth_accounts USING btree (user_id);


--
-- Name: idx_oauth_accounts_metadata_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_accounts_metadata_gin ON public.oauth_accounts USING gin (metadata);


--
-- Name: idx_oauth_accounts_provider_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_accounts_provider_id ON public.oauth_accounts USING btree (provider_id);


--
-- Name: idx_oauth_tokens_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_tokens_expires_at ON public.oauth_tokens USING btree (expires_at);


--
-- Name: idx_password_resets_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_resets_expires_at ON public.password_resets USING btree (expires_at);


--
-- Name: idx_password_resets_unused; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_resets_unused ON public.password_resets USING btree (token_hash) WHERE (used_at IS NULL);


--
-- Name: idx_password_resets_user_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_resets_user_used ON public.password_resets USING btree (user_id, used_at);


--
-- Name: idx_role_permissions_permission_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_role_permissions_permission_id ON public.role_permissions USING btree (permission_id);


--
-- Name: idx_user_profiles_metadata_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_metadata_gin ON public.user_profiles USING gin (metadata);


--
-- Name: idx_user_profiles_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_profiles_user_id ON public.user_profiles USING btree (user_id);


--
-- Name: idx_user_roles_role_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_roles_role_id ON public.user_roles USING btree (role_id);


--
-- Name: idx_user_sessions_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_expires_at ON public.user_sessions USING btree (expires_at);


--
-- Name: idx_user_sessions_last_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_last_used_at ON public.user_sessions USING btree (last_used_at);


--
-- Name: idx_user_sessions_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_sessions_user_created ON public.user_sessions USING btree (user_id, created_at);


--
-- Name: audit_logs_2026_06_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_actor_id ATTACH PARTITION public.audit_logs_2026_06_actor_id_idx;


--
-- Name: audit_logs_2026_06_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_created_at ATTACH PARTITION public.audit_logs_2026_06_created_at_idx;


--
-- Name: audit_logs_2026_06_entity_type_entity_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_entity ATTACH PARTITION public.audit_logs_2026_06_entity_type_entity_id_idx;


--
-- Name: audit_logs_2026_06_new_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_new_values_gin ATTACH PARTITION public.audit_logs_2026_06_new_values_idx;


--
-- Name: audit_logs_2026_06_old_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_old_values_gin ATTACH PARTITION public.audit_logs_2026_06_old_values_idx;


--
-- Name: audit_logs_2026_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_logs_pkey ATTACH PARTITION public.audit_logs_2026_06_pkey;


--
-- Name: audit_logs_2026_07_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_actor_id ATTACH PARTITION public.audit_logs_2026_07_actor_id_idx;


--
-- Name: audit_logs_2026_07_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_created_at ATTACH PARTITION public.audit_logs_2026_07_created_at_idx;


--
-- Name: audit_logs_2026_07_entity_type_entity_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_entity ATTACH PARTITION public.audit_logs_2026_07_entity_type_entity_id_idx;


--
-- Name: audit_logs_2026_07_new_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_new_values_gin ATTACH PARTITION public.audit_logs_2026_07_new_values_idx;


--
-- Name: audit_logs_2026_07_old_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_old_values_gin ATTACH PARTITION public.audit_logs_2026_07_old_values_idx;


--
-- Name: audit_logs_2026_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_logs_pkey ATTACH PARTITION public.audit_logs_2026_07_pkey;


--
-- Name: audit_logs_2026_08_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_actor_id ATTACH PARTITION public.audit_logs_2026_08_actor_id_idx;


--
-- Name: audit_logs_2026_08_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_created_at ATTACH PARTITION public.audit_logs_2026_08_created_at_idx;


--
-- Name: audit_logs_2026_08_entity_type_entity_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_entity ATTACH PARTITION public.audit_logs_2026_08_entity_type_entity_id_idx;


--
-- Name: audit_logs_2026_08_new_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_new_values_gin ATTACH PARTITION public.audit_logs_2026_08_new_values_idx;


--
-- Name: audit_logs_2026_08_old_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_old_values_gin ATTACH PARTITION public.audit_logs_2026_08_old_values_idx;


--
-- Name: audit_logs_2026_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_logs_pkey ATTACH PARTITION public.audit_logs_2026_08_pkey;


--
-- Name: audit_logs_2026_09_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_actor_id ATTACH PARTITION public.audit_logs_2026_09_actor_id_idx;


--
-- Name: audit_logs_2026_09_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_created_at ATTACH PARTITION public.audit_logs_2026_09_created_at_idx;


--
-- Name: audit_logs_2026_09_entity_type_entity_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_entity ATTACH PARTITION public.audit_logs_2026_09_entity_type_entity_id_idx;


--
-- Name: audit_logs_2026_09_new_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_new_values_gin ATTACH PARTITION public.audit_logs_2026_09_new_values_idx;


--
-- Name: audit_logs_2026_09_old_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_old_values_gin ATTACH PARTITION public.audit_logs_2026_09_old_values_idx;


--
-- Name: audit_logs_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_logs_pkey ATTACH PARTITION public.audit_logs_2026_09_pkey;


--
-- Name: audit_logs_2026_10_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_actor_id ATTACH PARTITION public.audit_logs_2026_10_actor_id_idx;


--
-- Name: audit_logs_2026_10_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_created_at ATTACH PARTITION public.audit_logs_2026_10_created_at_idx;


--
-- Name: audit_logs_2026_10_entity_type_entity_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_entity ATTACH PARTITION public.audit_logs_2026_10_entity_type_entity_id_idx;


--
-- Name: audit_logs_2026_10_new_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_new_values_gin ATTACH PARTITION public.audit_logs_2026_10_new_values_idx;


--
-- Name: audit_logs_2026_10_old_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_old_values_gin ATTACH PARTITION public.audit_logs_2026_10_old_values_idx;


--
-- Name: audit_logs_2026_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_logs_pkey ATTACH PARTITION public.audit_logs_2026_10_pkey;


--
-- Name: audit_logs_2026_11_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_actor_id ATTACH PARTITION public.audit_logs_2026_11_actor_id_idx;


--
-- Name: audit_logs_2026_11_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_created_at ATTACH PARTITION public.audit_logs_2026_11_created_at_idx;


--
-- Name: audit_logs_2026_11_entity_type_entity_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_entity ATTACH PARTITION public.audit_logs_2026_11_entity_type_entity_id_idx;


--
-- Name: audit_logs_2026_11_new_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_new_values_gin ATTACH PARTITION public.audit_logs_2026_11_new_values_idx;


--
-- Name: audit_logs_2026_11_old_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_old_values_gin ATTACH PARTITION public.audit_logs_2026_11_old_values_idx;


--
-- Name: audit_logs_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_logs_pkey ATTACH PARTITION public.audit_logs_2026_11_pkey;


--
-- Name: audit_logs_2026_12_actor_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_actor_id ATTACH PARTITION public.audit_logs_2026_12_actor_id_idx;


--
-- Name: audit_logs_2026_12_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_created_at ATTACH PARTITION public.audit_logs_2026_12_created_at_idx;


--
-- Name: audit_logs_2026_12_entity_type_entity_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_entity ATTACH PARTITION public.audit_logs_2026_12_entity_type_entity_id_idx;


--
-- Name: audit_logs_2026_12_new_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_new_values_gin ATTACH PARTITION public.audit_logs_2026_12_new_values_idx;


--
-- Name: audit_logs_2026_12_old_values_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_audit_logs_old_values_gin ATTACH PARTITION public.audit_logs_2026_12_old_values_idx;


--
-- Name: audit_logs_2026_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.audit_logs_pkey ATTACH PARTITION public.audit_logs_2026_12_pkey;


--
-- Name: auth_login_history_2026_06_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_created_at ATTACH PARTITION public.auth_login_history_2026_06_created_at_idx;


--
-- Name: auth_login_history_2026_06_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.auth_login_history_pkey ATTACH PARTITION public.auth_login_history_2026_06_pkey;


--
-- Name: auth_login_history_2026_06_provider_id_user_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_provider_user_created ATTACH PARTITION public.auth_login_history_2026_06_provider_id_user_id_created_at_idx;


--
-- Name: auth_login_history_2026_06_user_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_user ATTACH PARTITION public.auth_login_history_2026_06_user_id_idx;


--
-- Name: auth_login_history_2026_07_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_created_at ATTACH PARTITION public.auth_login_history_2026_07_created_at_idx;


--
-- Name: auth_login_history_2026_07_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.auth_login_history_pkey ATTACH PARTITION public.auth_login_history_2026_07_pkey;


--
-- Name: auth_login_history_2026_07_provider_id_user_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_provider_user_created ATTACH PARTITION public.auth_login_history_2026_07_provider_id_user_id_created_at_idx;


--
-- Name: auth_login_history_2026_07_user_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_user ATTACH PARTITION public.auth_login_history_2026_07_user_id_idx;


--
-- Name: auth_login_history_2026_08_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_created_at ATTACH PARTITION public.auth_login_history_2026_08_created_at_idx;


--
-- Name: auth_login_history_2026_08_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.auth_login_history_pkey ATTACH PARTITION public.auth_login_history_2026_08_pkey;


--
-- Name: auth_login_history_2026_08_provider_id_user_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_provider_user_created ATTACH PARTITION public.auth_login_history_2026_08_provider_id_user_id_created_at_idx;


--
-- Name: auth_login_history_2026_08_user_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_user ATTACH PARTITION public.auth_login_history_2026_08_user_id_idx;


--
-- Name: auth_login_history_2026_09_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_created_at ATTACH PARTITION public.auth_login_history_2026_09_created_at_idx;


--
-- Name: auth_login_history_2026_09_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.auth_login_history_pkey ATTACH PARTITION public.auth_login_history_2026_09_pkey;


--
-- Name: auth_login_history_2026_09_provider_id_user_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_provider_user_created ATTACH PARTITION public.auth_login_history_2026_09_provider_id_user_id_created_at_idx;


--
-- Name: auth_login_history_2026_09_user_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_user ATTACH PARTITION public.auth_login_history_2026_09_user_id_idx;


--
-- Name: auth_login_history_2026_10_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_created_at ATTACH PARTITION public.auth_login_history_2026_10_created_at_idx;


--
-- Name: auth_login_history_2026_10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.auth_login_history_pkey ATTACH PARTITION public.auth_login_history_2026_10_pkey;


--
-- Name: auth_login_history_2026_10_provider_id_user_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_provider_user_created ATTACH PARTITION public.auth_login_history_2026_10_provider_id_user_id_created_at_idx;


--
-- Name: auth_login_history_2026_10_user_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_user ATTACH PARTITION public.auth_login_history_2026_10_user_id_idx;


--
-- Name: auth_login_history_2026_11_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_created_at ATTACH PARTITION public.auth_login_history_2026_11_created_at_idx;


--
-- Name: auth_login_history_2026_11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.auth_login_history_pkey ATTACH PARTITION public.auth_login_history_2026_11_pkey;


--
-- Name: auth_login_history_2026_11_provider_id_user_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_provider_user_created ATTACH PARTITION public.auth_login_history_2026_11_provider_id_user_id_created_at_idx;


--
-- Name: auth_login_history_2026_11_user_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_user ATTACH PARTITION public.auth_login_history_2026_11_user_id_idx;


--
-- Name: auth_login_history_2026_12_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_created_at ATTACH PARTITION public.auth_login_history_2026_12_created_at_idx;


--
-- Name: auth_login_history_2026_12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.auth_login_history_pkey ATTACH PARTITION public.auth_login_history_2026_12_pkey;


--
-- Name: auth_login_history_2026_12_provider_id_user_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_provider_user_created ATTACH PARTITION public.auth_login_history_2026_12_provider_id_user_id_created_at_idx;


--
-- Name: auth_login_history_2026_12_user_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_auth_login_history_user ATTACH PARTITION public.auth_login_history_2026_12_user_id_idx;


--
-- Name: user_passwords trg_user_passwords_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_passwords_updated_at BEFORE UPDATE ON public.user_passwords FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_profiles trg_user_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_profiles_updated_at BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: users trg_users_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: email_verifications email_verifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verifications
    ADD CONSTRAINT email_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: audit_logs fk_audit_logs_actor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs
    ADD CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: auth_login_history fk_auth_login_history_provider; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.auth_login_history
    ADD CONSTRAINT fk_auth_login_history_provider FOREIGN KEY (provider_id) REFERENCES public.oauth_providers(id) ON DELETE SET NULL;


--
-- Name: auth_login_history fk_auth_login_history_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.auth_login_history
    ADD CONSTRAINT fk_auth_login_history_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: oauth_accounts oauth_accounts_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_accounts
    ADD CONSTRAINT oauth_accounts_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.oauth_providers(id) ON DELETE CASCADE;


--
-- Name: oauth_accounts oauth_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_accounts
    ADD CONSTRAINT oauth_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: oauth_tokens oauth_tokens_oauth_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_oauth_account_id_fkey FOREIGN KEY (oauth_account_id) REFERENCES public.oauth_accounts(id) ON DELETE CASCADE;


--
-- Name: password_resets password_resets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_passwords user_passwords_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_passwords
    ADD CONSTRAINT user_passwords_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_profiles user_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict aQU7qPXIYSrbIbaw6ZVIWt0apajg3xZ9g5m0WuNONmbEEWxRM0bUnpsmeth7zUf

