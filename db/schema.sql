--
-- PostgreSQL database dump
--


-- Dumped from database version 14.23 (Debian 14.23-1.pgdg13+1)
-- Dumped by pg_dump version 14.23 (Debian 14.23-1.pgdg13+1)

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

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id integer NOT NULL,
    name character varying DEFAULT ''::character varying NOT NULL,
    nickname character varying DEFAULT ''::character varying NOT NULL,
    password character varying DEFAULT ''::character varying NOT NULL,
    image character varying DEFAULT ''::character varying NOT NULL,
    "apiToken" character varying DEFAULT ''::character varying NOT NULL,
    note integer DEFAULT 0 NOT NULL,
    role character varying DEFAULT ''::character varying NOT NULL,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone NOT NULL,
    description text DEFAULT ''::text NOT NULL
);


--
-- Name: accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;


--
-- Name: agentAccessTokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."agentAccessTokens" (
    id integer NOT NULL,
    name character varying DEFAULT ''::character varying NOT NULL,
    "tokenHash" character varying(64) NOT NULL,
    token text,
    "accountId" integer NOT NULL,
    "workspaceId" integer NOT NULL,
    permissions json DEFAULT '{"notes":["read","write"],"comments":["read","write"],"tags":["read"]}'::json NOT NULL,
    "expiresAt" timestamp(6) with time zone,
    "revokedAt" timestamp(6) with time zone,
    "lastUsedAt" timestamp(6) with time zone,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: agentAccessTokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."agentAccessTokens_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agentAccessTokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."agentAccessTokens_id_seq" OWNED BY public."agentAccessTokens".id;


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id integer NOT NULL,
    name character varying DEFAULT ''::character varying NOT NULL,
    path character varying DEFAULT ''::character varying NOT NULL,
    size numeric DEFAULT 0 NOT NULL,
    "noteId" integer,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone NOT NULL,
    type character varying DEFAULT ''::character varying NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    depth integer,
    "perfixPath" character varying DEFAULT ''::character varying,
    "accountId" integer,
    metadata json,
    "workspaceId" integer
);


--
-- Name: attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attachments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attachments_id_seq OWNED BY public.attachments.id;


--
-- Name: cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cache (
    id integer NOT NULL,
    key character varying NOT NULL,
    value json NOT NULL,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone NOT NULL
);


--
-- Name: cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cache_id_seq OWNED BY public.cache.id;


--
-- Name: comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comments (
    id integer NOT NULL,
    content text NOT NULL,
    "accountId" integer,
    "noteId" integer NOT NULL,
    "parentId" integer,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone NOT NULL,
    kind character varying DEFAULT 'annotation'::character varying NOT NULL,
    status character varying DEFAULT 'open'::character varying NOT NULL,
    metadata json,
    "workspaceId" integer
);


--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: comments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.comments_id_seq OWNED BY public.comments.id;


--
-- Name: config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.config (
    id integer NOT NULL,
    key character varying DEFAULT ''::character varying NOT NULL,
    config json,
    "userId" integer,
    "workspaceId" integer
);


--
-- Name: config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.config_id_seq OWNED BY public.config.id;


--
-- Name: fonts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fonts (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    "displayName" character varying(255) NOT NULL,
    url text,
    "fileData" bytea,
    "isLocal" boolean DEFAULT false NOT NULL,
    "isSystem" boolean DEFAULT false NOT NULL,
    weights json NOT NULL,
    category character varying(50) DEFAULT 'sans-serif'::character varying NOT NULL,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone NOT NULL
);


--
-- Name: fonts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.fonts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: fonts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.fonts_id_seq OWNED BY public.fonts.id;


--
-- Name: noteHistory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."noteHistory" (
    id integer NOT NULL,
    "noteId" integer NOT NULL,
    content text NOT NULL,
    metadata json,
    version integer NOT NULL,
    "accountId" integer,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "workspaceId" integer
);


--
-- Name: noteHistory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."noteHistory_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: noteHistory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."noteHistory_id_seq" OWNED BY public."noteHistory".id;


--
-- Name: noteReference; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."noteReference" (
    id integer NOT NULL,
    "fromNoteId" integer NOT NULL,
    "toNoteId" integer NOT NULL,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: noteReference_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."noteReference_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: noteReference_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."noteReference_id_seq" OWNED BY public."noteReference".id;


--
-- Name: operationLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."operationLog" (
    id integer NOT NULL,
    "accountId" integer,
    "workspaceId" integer,
    "actorType" character varying DEFAULT 'user'::character varying NOT NULL,
    "actorAccountId" integer,
    "actorAgentTokenId" integer,
    "actorLabel" character varying DEFAULT ''::character varying NOT NULL,
    action character varying DEFAULT ''::character varying NOT NULL,
    "noteId" integer,
    "noteType" integer,
    "noteTitle" character varying DEFAULT ''::character varying NOT NULL,
    "changedFields" json DEFAULT '[]'::json NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    details json,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: operationLog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."operationLog_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: operationLog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."operationLog_id_seq" OWNED BY public."operationLog".id;


--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id integer NOT NULL,
    type integer DEFAULT 0 NOT NULL,
    content character varying DEFAULT ''::character varying NOT NULL,
    "isArchived" boolean DEFAULT false NOT NULL,
    "isRecycle" boolean DEFAULT false NOT NULL,
    "isTop" boolean DEFAULT false NOT NULL,
    metadata json,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone NOT NULL,
    "isReviewed" boolean DEFAULT false NOT NULL,
    "accountId" integer,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "workspaceId" integer
);


--
-- Name: notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notes_id_seq OWNED BY public.notes.id;


--
-- Name: tag; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tag (
    id integer NOT NULL,
    name character varying DEFAULT ''::character varying NOT NULL,
    icon character varying DEFAULT ''::character varying NOT NULL,
    parent integer DEFAULT 0 NOT NULL,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone NOT NULL,
    "accountId" integer,
    "sortOrder" integer DEFAULT 0 NOT NULL,
    "workspaceId" integer
);


--
-- Name: tag_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tag_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tag_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tag_id_seq OWNED BY public.tag.id;


--
-- Name: tagsToNote; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."tagsToNote" (
    id integer NOT NULL,
    "noteId" integer DEFAULT 0 NOT NULL,
    "tagId" integer DEFAULT 0 NOT NULL
);


--
-- Name: tagsToNote_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public."tagsToNote_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tagsToNote_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public."tagsToNote_id_seq" OWNED BY public."tagsToNote".id;


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id integer NOT NULL,
    name character varying DEFAULT '默认工作区'::character varying NOT NULL,
    description character varying DEFAULT ''::character varying NOT NULL,
    icon character varying DEFAULT ''::character varying NOT NULL,
    color character varying DEFAULT ''::character varying NOT NULL,
    "accountId" integer NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: workspaces_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workspaces_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workspaces_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workspaces_id_seq OWNED BY public.workspaces.id;


--
-- Name: accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);


--
-- Name: agentAccessTokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."agentAccessTokens" ALTER COLUMN id SET DEFAULT nextval('public."agentAccessTokens_id_seq"'::regclass);


--
-- Name: attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments ALTER COLUMN id SET DEFAULT nextval('public.attachments_id_seq'::regclass);


--
-- Name: cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache ALTER COLUMN id SET DEFAULT nextval('public.cache_id_seq'::regclass);


--
-- Name: comments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments ALTER COLUMN id SET DEFAULT nextval('public.comments_id_seq'::regclass);


--
-- Name: config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config ALTER COLUMN id SET DEFAULT nextval('public.config_id_seq'::regclass);


--
-- Name: fonts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fonts ALTER COLUMN id SET DEFAULT nextval('public.fonts_id_seq'::regclass);


--
-- Name: noteHistory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."noteHistory" ALTER COLUMN id SET DEFAULT nextval('public."noteHistory_id_seq"'::regclass);


--
-- Name: noteReference id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."noteReference" ALTER COLUMN id SET DEFAULT nextval('public."noteReference_id_seq"'::regclass);


--
-- Name: operationLog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."operationLog" ALTER COLUMN id SET DEFAULT nextval('public."operationLog_id_seq"'::regclass);


--
-- Name: notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes ALTER COLUMN id SET DEFAULT nextval('public.notes_id_seq'::regclass);


--
-- Name: tag id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag ALTER COLUMN id SET DEFAULT nextval('public.tag_id_seq'::regclass);


--
-- Name: tagsToNote id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."tagsToNote" ALTER COLUMN id SET DEFAULT nextval('public."tagsToNote_id_seq"'::regclass);


--
-- Name: workspaces id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces ALTER COLUMN id SET DEFAULT nextval('public.workspaces_id_seq'::regclass);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: agentAccessTokens agentAccessTokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."agentAccessTokens"
    ADD CONSTRAINT "agentAccessTokens_pkey" PRIMARY KEY (id);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: cache cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cache
    ADD CONSTRAINT cache_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: config config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config
    ADD CONSTRAINT config_pkey PRIMARY KEY (id);


--
-- Name: fonts fonts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fonts
    ADD CONSTRAINT fonts_pkey PRIMARY KEY (id);


--
-- Name: noteHistory noteHistory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."noteHistory"
    ADD CONSTRAINT "noteHistory_pkey" PRIMARY KEY (id);


--
-- Name: noteReference noteReference_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."noteReference"
    ADD CONSTRAINT "noteReference_pkey" PRIMARY KEY (id);


--
-- Name: operationLog operationLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."operationLog"
    ADD CONSTRAINT "operationLog_pkey" PRIMARY KEY (id);


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- Name: tag tag_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT tag_pkey PRIMARY KEY (id);


--
-- Name: tagsToNote tagsToNote_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."tagsToNote"
    ADD CONSTRAINT "tagsToNote_pkey" PRIMARY KEY ("noteId", "tagId");


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: agentAccessTokens_accountId_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "agentAccessTokens_accountId_workspaceId_idx" ON public."agentAccessTokens" USING btree ("accountId", "workspaceId");


--
-- Name: agentAccessTokens_revokedAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "agentAccessTokens_revokedAt_idx" ON public."agentAccessTokens" USING btree ("revokedAt");


--
-- Name: agentAccessTokens_tokenHash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "agentAccessTokens_tokenHash_key" ON public."agentAccessTokens" USING btree ("tokenHash");


--
-- Name: agentAccessTokens_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "agentAccessTokens_workspaceId_idx" ON public."agentAccessTokens" USING btree ("workspaceId");


--
-- Name: attachments_accountId_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "attachments_accountId_workspaceId_idx" ON public.attachments USING btree ("accountId", "workspaceId");


--
-- Name: attachments_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "attachments_workspaceId_idx" ON public.attachments USING btree ("workspaceId");


--
-- Name: cache_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cache_key_key ON public.cache USING btree (key);


--
-- Name: comments_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "comments_accountId_idx" ON public.comments USING btree ("accountId");


--
-- Name: comments_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_kind_idx ON public.comments USING btree (kind);


--
-- Name: comments_noteId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "comments_noteId_idx" ON public.comments USING btree ("noteId");


--
-- Name: comments_parentId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "comments_parentId_idx" ON public.comments USING btree ("parentId");


--
-- Name: comments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX comments_status_idx ON public.comments USING btree (status);


--
-- Name: comments_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "comments_workspaceId_idx" ON public.comments USING btree ("workspaceId");


--
-- Name: config_userId_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "config_userId_workspaceId_idx" ON public.config USING btree ("userId", "workspaceId");


--
-- Name: config_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "config_workspaceId_idx" ON public.config USING btree ("workspaceId");


--
-- Name: fonts_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fonts_name_key ON public.fonts USING btree (name);


--
-- Name: noteHistory_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "noteHistory_accountId_idx" ON public."noteHistory" USING btree ("accountId");


--
-- Name: noteHistory_noteId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "noteHistory_noteId_idx" ON public."noteHistory" USING btree ("noteId");


--
-- Name: noteHistory_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "noteHistory_workspaceId_idx" ON public."noteHistory" USING btree ("workspaceId");


--
-- Name: noteReference_fromNoteId_toNoteId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "noteReference_fromNoteId_toNoteId_key" ON public."noteReference" USING btree ("fromNoteId", "toNoteId");


--
-- Name: operationLog_workspaceId_actorType_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "operationLog_workspaceId_actorType_idx" ON public."operationLog" USING btree ("workspaceId", "actorType");


--
-- Name: operationLog_workspaceId_createdAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "operationLog_workspaceId_createdAt_idx" ON public."operationLog" USING btree ("workspaceId", "createdAt");


--
-- Name: operationLog_workspaceId_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "operationLog_workspaceId_id_idx" ON public."operationLog" USING btree ("workspaceId", id);


--
-- Name: operationLog_workspaceId_noteId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "operationLog_workspaceId_noteId_idx" ON public."operationLog" USING btree ("workspaceId", "noteId");


--
-- Name: operationLog_workspaceId_noteType_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "operationLog_workspaceId_noteType_idx" ON public."operationLog" USING btree ("workspaceId", "noteType");


--
-- Name: notes_accountId_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "notes_accountId_workspaceId_idx" ON public.notes USING btree ("accountId", "workspaceId");


--
-- Name: notes_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "notes_workspaceId_idx" ON public.notes USING btree ("workspaceId");


--
-- Name: tag_accountId_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "tag_accountId_workspaceId_idx" ON public.tag USING btree ("accountId", "workspaceId");


--
-- Name: tag_workspaceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "tag_workspaceId_idx" ON public.tag USING btree ("workspaceId");


--
-- Name: workspaces_accountId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "workspaces_accountId_idx" ON public.workspaces USING btree ("accountId");


--
-- Name: workspaces_isDefault_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "workspaces_isDefault_idx" ON public.workspaces USING btree ("isDefault");


--
-- Name: agentAccessTokens agentAccessTokens_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."agentAccessTokens"
    ADD CONSTRAINT "agentAccessTokens_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: agentAccessTokens agentAccessTokens_workspaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."agentAccessTokens"
    ADD CONSTRAINT "agentAccessTokens_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: attachments attachments_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT "attachments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: attachments attachments_noteId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT "attachments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES public.notes(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: attachments attachments_workspaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT "attachments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: comments comments_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT "comments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: comments comments_noteId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT "comments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES public.notes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: comments comments_parentId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public.comments(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: comments comments_workspaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT "comments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: config config_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config
    ADD CONSTRAINT "config_userId_fkey" FOREIGN KEY ("userId") REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: config config_workspaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.config
    ADD CONSTRAINT "config_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: noteHistory noteHistory_noteId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."noteHistory"
    ADD CONSTRAINT "noteHistory_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES public.notes(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: noteHistory noteHistory_workspaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."noteHistory"
    ADD CONSTRAINT "noteHistory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: noteReference noteReference_fromNoteId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."noteReference"
    ADD CONSTRAINT "noteReference_fromNoteId_fkey" FOREIGN KEY ("fromNoteId") REFERENCES public.notes(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: noteReference noteReference_toNoteId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."noteReference"
    ADD CONSTRAINT "noteReference_toNoteId_fkey" FOREIGN KEY ("toNoteId") REFERENCES public.notes(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: operationLog operationLog_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."operationLog"
    ADD CONSTRAINT "operationLog_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: operationLog operationLog_workspaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."operationLog"
    ADD CONSTRAINT "operationLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: notes notes_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT "notes_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: notes notes_workspaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT "notes_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: tag tag_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT "tag_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: tag tag_workspaceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tag
    ADD CONSTRAINT "tag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: tagsToNote tagsToNote_noteId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."tagsToNote"
    ADD CONSTRAINT "tagsToNote_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES public.notes(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: tagsToNote tagsToNote_tagId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."tagsToNote"
    ADD CONSTRAINT "tagsToNote_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES public.tag(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: workspaces workspaces_accountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT "workspaces_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
