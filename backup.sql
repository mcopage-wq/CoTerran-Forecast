--
-- PostgreSQL database dump
--

\restrict YRf3g81415FKhmdpfTJ0HIPwu1DpQI6iNTkrcOHRg5oIJ9FRn5FazoHGxX8Hpir

-- Dumped from database version 17.6 (Debian 17.6-2.pgdg13+1)
-- Dumped by pg_dump version 18.0

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
-- Name: calculate_brier_scores(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.calculate_brier_scores() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only run when market is resolved
    IF NEW.status = 'resolved' AND NEW.outcome IS NOT NULL THEN
        UPDATE predictions
        SET brier_score = POWER((prediction/100.0 - NEW.outcome/100.0), 2),
            points_earned = CASE
                WHEN POWER((prediction/100.0 - NEW.outcome/100.0), 2) < 0.1 THEN 100
                WHEN POWER((prediction/100.0 - NEW.outcome/100.0), 2) < 0.2 THEN 75
                WHEN POWER((prediction/100.0 - NEW.outcome/100.0), 2) < 0.3 THEN 50
                ELSE 25
            END
        WHERE market_id = NEW.id;
        
        -- Update user accuracy scores
        WITH user_scores AS (
            SELECT 
                user_id,
                COUNT(*) as total,
                AVG(brier_score) as avg_brier,
                (1 - AVG(brier_score)) * 100 as accuracy
            FROM predictions
            WHERE brier_score IS NOT NULL
            GROUP BY user_id
        )
        UPDATE users u
        SET 
            accuracy_score = s.accuracy,
            total_predictions = s.total
        FROM user_scores s
        WHERE u.id = s.user_id;
    END IF;
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.calculate_brier_scores() OWNER TO postgres;

--
-- Name: update_market_aggregates(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_market_aggregates() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    WITH stats AS (
        SELECT
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY prediction) as median,
            AVG(prediction) as mean,
            STDDEV(prediction) as std_dev,
            COUNT(CASE WHEN prediction BETWEEN 0 AND 25 THEN 1 END) as bucket_0_25,
            COUNT(CASE WHEN prediction BETWEEN 26 AND 50 THEN 1 END) as bucket_26_50,
            COUNT(CASE WHEN prediction BETWEEN 51 AND 75 THEN 1 END) as bucket_51_75,
            COUNT(CASE WHEN prediction BETWEEN 76 AND 100 THEN 1 END) as bucket_76_100
        FROM predictions
        WHERE market_id = COALESCE(NEW.market_id, OLD.market_id)
    )
    INSERT INTO market_aggregates (market_id, median_prediction, mean_prediction, std_deviation,
                                   predictions_0_25, predictions_26_50, predictions_51_75, predictions_76_100)
    SELECT COALESCE(NEW.market_id, OLD.market_id), median, mean, std_dev,
           bucket_0_25, bucket_26_50, bucket_51_75, bucket_76_100
    FROM stats
    ON CONFLICT (market_id) DO UPDATE SET
        median_prediction = EXCLUDED.median_prediction,
        mean_prediction = EXCLUDED.mean_prediction,
        std_deviation = EXCLUDED.std_deviation,
        predictions_0_25 = EXCLUDED.predictions_0_25,
        predictions_26_50 = EXCLUDED.predictions_26_50,
        predictions_51_75 = EXCLUDED.predictions_51_75,
        predictions_76_100 = EXCLUDED.predictions_76_100,
        last_updated = NOW();
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_market_aggregates() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_usage; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.api_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid,
    endpoint character varying(255) NOT NULL,
    method character varying(10) NOT NULL,
    response_time_ms integer,
    status_code integer,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.api_usage OWNER TO postgres;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    action character varying(100) NOT NULL,
    entity_type character varying(50),
    entity_id uuid,
    details jsonb,
    created_at timestamp without time zone DEFAULT now()
);


ALTER TABLE public.audit_log OWNER TO postgres;

--
-- Name: comments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    market_id uuid,
    user_id uuid,
    parent_id uuid,
    content text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    is_edited boolean DEFAULT false,
    is_flagged boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    CONSTRAINT non_empty_content CHECK ((length(TRIM(BOTH FROM content)) > 0))
);


ALTER TABLE public.comments OWNER TO postgres;

--
-- Name: customers; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_name character varying(255) NOT NULL,
    contact_email character varying(255) NOT NULL,
    contact_name character varying(255),
    subscription_tier character varying(20),
    monthly_fee numeric(10,2),
    api_key character varying(255),
    is_active boolean DEFAULT true,
    trial_end_date date,
    subscription_start date,
    api_calls_this_month integer DEFAULT 0,
    api_call_limit integer DEFAULT 1000,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT valid_tier CHECK (((subscription_tier)::text = ANY ((ARRAY['free'::character varying, 'basic'::character varying, 'premium'::character varying, 'enterprise'::character varying])::text[])))
);


ALTER TABLE public.customers OWNER TO postgres;

--
-- Name: TABLE customers; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.customers IS 'B2B customers accessing prediction data via API';


--
-- Name: market_aggregates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.market_aggregates (
    market_id uuid NOT NULL,
    median_prediction numeric(5,2),
    mean_prediction numeric(5,2),
    std_deviation numeric(5,2),
    predictions_0_25 integer DEFAULT 0,
    predictions_26_50 integer DEFAULT 0,
    predictions_51_75 integer DEFAULT 0,
    predictions_76_100 integer DEFAULT 0,
    last_updated timestamp without time zone DEFAULT now()
);


ALTER TABLE public.market_aggregates OWNER TO postgres;

--
-- Name: TABLE market_aggregates; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.market_aggregates IS 'Calculated consensus predictions across all experts';


--
-- Name: markets; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.markets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    question text NOT NULL,
    description text,
    category character varying(50) NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    close_date timestamp without time zone NOT NULL,
    resolution_date timestamp without time zone,
    status character varying(20) DEFAULT 'open'::character varying,
    outcome numeric(5,2),
    resolution_source text,
    resolution_notes text,
    resolved_by uuid,
    created_by uuid,
    data_source character varying(255),
    resolution_criteria text NOT NULL,
    prediction_count integer DEFAULT 0,
    discussion_count integer DEFAULT 0,
    view_count integer DEFAULT 0,
    is_featured boolean DEFAULT false,
    CONSTRAINT valid_dates CHECK ((close_date > created_at)),
    CONSTRAINT valid_outcome CHECK (((outcome IS NULL) OR ((outcome >= (0)::numeric) AND (outcome <= (100)::numeric)))),
    CONSTRAINT valid_status CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'closed'::character varying, 'resolved'::character varying, 'cancelled'::character varying])::text[])))
);


ALTER TABLE public.markets OWNER TO postgres;

--
-- Name: TABLE markets; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.markets IS 'Climate prediction markets with manual resolution';


--
-- Name: predictions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.predictions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    market_id uuid,
    user_id uuid,
    prediction numeric(5,2) NOT NULL,
    confidence character varying(20),
    reasoning text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    brier_score numeric(10,8),
    points_earned integer,
    is_public boolean DEFAULT true,
    CONSTRAINT valid_prediction CHECK (((prediction >= (0)::numeric) AND (prediction <= (100)::numeric)))
);


ALTER TABLE public.predictions OWNER TO postgres;

--
-- Name: TABLE predictions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.predictions IS 'Individual expert predictions (0-100 probability)';


--
-- Name: user_accuracy_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_accuracy_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    period_start date NOT NULL,
    period_end date NOT NULL,
    predictions_made integer DEFAULT 0,
    predictions_resolved integer DEFAULT 0,
    avg_brier_score numeric(10,8),
    accuracy_score numeric(5,2),
    rank_in_period integer,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT valid_period CHECK ((period_end > period_start))
);


ALTER TABLE public.user_accuracy_history OWNER TO postgres;

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(255) NOT NULL,
    organization character varying(255),
    expertise_area character varying(100),
    bio text,
    is_admin boolean DEFAULT false,
    is_approved boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    last_login timestamp without time zone,
    total_predictions integer DEFAULT 0,
    accuracy_score numeric(5,2),
    rank integer,
    email_notifications boolean DEFAULT true,
    weekly_digest boolean DEFAULT true
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.users IS 'Expert forecasters with approval required';


--
-- Data for Name: api_usage; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.api_usage (id, customer_id, endpoint, method, response_time_ms, status_code, created_at) FROM stdin;
\.


--
-- Data for Name: audit_log; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.audit_log (id, user_id, action, entity_type, entity_id, details, created_at) FROM stdin;
\.


--
-- Data for Name: comments; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.comments (id, market_id, user_id, parent_id, content, created_at, updated_at, is_edited, is_flagged, is_deleted) FROM stdin;
\.


--
-- Data for Name: customers; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.customers (id, organization_name, contact_email, contact_name, subscription_tier, monthly_fee, api_key, is_active, trial_end_date, subscription_start, api_calls_this_month, api_call_limit, created_at) FROM stdin;
\.


--
-- Data for Name: market_aggregates; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.market_aggregates (market_id, median_prediction, mean_prediction, std_deviation, predictions_0_25, predictions_26_50, predictions_51_75, predictions_76_100, last_updated) FROM stdin;
\.


--
-- Data for Name: markets; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.markets (id, question, description, category, created_at, close_date, resolution_date, status, outcome, resolution_source, resolution_notes, resolved_by, created_by, data_source, resolution_criteria, prediction_count, discussion_count, view_count, is_featured) FROM stdin;
58ac58fb-6cf0-4cdb-acd7-f0afafdd5ff5	Will 2025 be in Australia's top 5 warmest years on record?	Based on mean temperature anomaly compared to 1961-1990 baseline. This market will resolve based on the BOM Annual Climate Statement published in January 2026.	Temperature	2025-10-07 01:55:23.980411	2025-12-31 23:59:59	\N	open	\N	\N	\N	\N	b45c5af3-ae3b-48cc-ac8f-debd696032a9	Bureau of Meteorology Annual Climate Statement	Market resolves to YES (100) if 2025 ranks in the top 5 warmest years in BOM records. Resolves to NO (0) if it does not. Based on official BOM Annual Climate Statement published in January 2026.	0	0	0	f
\.


--
-- Data for Name: predictions; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.predictions (id, market_id, user_id, prediction, confidence, reasoning, created_at, updated_at, brier_score, points_earned, is_public) FROM stdin;
\.


--
-- Data for Name: user_accuracy_history; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.user_accuracy_history (id, user_id, period_start, period_end, predictions_made, predictions_resolved, avg_brier_score, accuracy_score, rank_in_period, created_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.users (id, email, password_hash, full_name, organization, expertise_area, bio, is_admin, is_approved, created_at, last_login, total_predictions, accuracy_score, rank, email_notifications, weekly_digest) FROM stdin;
b45c5af3-ae3b-48cc-ac8f-debd696032a9	admin@climateforecast.au	$2b$10$dummy_hash	Admin User	ClimateMarket	Platform Admin	\N	t	t	2025-10-07 01:55:23.980411	\N	0	\N	\N	t	t
896cdbef-1512-4179-af75-7fa1e58913d8	expert1@example.com	$2b$10$dummy_hash	Dr. Sarah Chen	University of Melbourne	Climate Science	\N	f	t	2025-10-07 01:55:23.980411	\N	0	\N	\N	t	t
ccbb3ece-4db5-47ba-b8c4-8d161c2cce33	expert2@example.com	$2b$10$dummy_hash	Dr. James Wilson	CSIRO	Marine Biology	\N	f	t	2025-10-07 01:55:23.980411	\N	0	\N	\N	t	t
4761f18e-03b2-4cd8-9e1c-7cc458e20dad	mcopage@coterran.co	$2b$10$YUsvGAWgm7kViOeSUMyoX.VAPm0kEoLxz2gId8lY8uMhG/5/U0NGy	Mike Copage	CoTerran	Admin	\N	t	t	2025-10-07 01:57:43.899284	\N	0	\N	\N	t	t
\.


--
-- Name: api_usage api_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_usage
    ADD CONSTRAINT api_usage_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: customers customers_api_key_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_api_key_key UNIQUE (api_key);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: market_aggregates market_aggregates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.market_aggregates
    ADD CONSTRAINT market_aggregates_pkey PRIMARY KEY (market_id);


--
-- Name: markets markets_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.markets
    ADD CONSTRAINT markets_pkey PRIMARY KEY (id);


--
-- Name: predictions one_prediction_per_user_market; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT one_prediction_per_user_market UNIQUE (market_id, user_id);


--
-- Name: predictions predictions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_pkey PRIMARY KEY (id);


--
-- Name: user_accuracy_history user_accuracy_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_accuracy_history
    ADD CONSTRAINT user_accuracy_history_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_accuracy_period; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_accuracy_period ON public.user_accuracy_history USING btree (period_start, period_end);


--
-- Name: idx_accuracy_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_accuracy_user ON public.user_accuracy_history USING btree (user_id);


--
-- Name: idx_api_usage_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_api_usage_created ON public.api_usage USING btree (created_at);


--
-- Name: idx_api_usage_customer; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_api_usage_customer ON public.api_usage USING btree (customer_id);


--
-- Name: idx_audit_action; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_action ON public.audit_log USING btree (action);


--
-- Name: idx_audit_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_created ON public.audit_log USING btree (created_at);


--
-- Name: idx_audit_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_user ON public.audit_log USING btree (user_id);


--
-- Name: idx_comments_market; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_comments_market ON public.comments USING btree (market_id);


--
-- Name: idx_comments_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_comments_parent ON public.comments USING btree (parent_id);


--
-- Name: idx_comments_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_comments_user ON public.comments USING btree (user_id);


--
-- Name: idx_customers_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_customers_active ON public.customers USING btree (is_active);


--
-- Name: idx_customers_api_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_customers_api_key ON public.customers USING btree (api_key);


--
-- Name: idx_markets_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_markets_category ON public.markets USING btree (category);


--
-- Name: idx_markets_close_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_markets_close_date ON public.markets USING btree (close_date);


--
-- Name: idx_markets_featured; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_markets_featured ON public.markets USING btree (is_featured) WHERE (is_featured = true);


--
-- Name: idx_markets_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_markets_status ON public.markets USING btree (status);


--
-- Name: idx_predictions_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_predictions_created ON public.predictions USING btree (created_at);


--
-- Name: idx_predictions_market; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_predictions_market ON public.predictions USING btree (market_id);


--
-- Name: idx_predictions_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_predictions_user ON public.predictions USING btree (user_id);


--
-- Name: idx_users_accuracy; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_accuracy ON public.users USING btree (accuracy_score DESC NULLS LAST);


--
-- Name: idx_users_approved; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_approved ON public.users USING btree (is_approved);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_email ON public.users USING btree (email);


--
-- Name: markets trigger_calculate_brier_scores; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_calculate_brier_scores AFTER UPDATE ON public.markets FOR EACH ROW EXECUTE FUNCTION public.calculate_brier_scores();


--
-- Name: predictions trigger_update_market_aggregates; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trigger_update_market_aggregates AFTER INSERT OR DELETE OR UPDATE ON public.predictions FOR EACH ROW EXECUTE FUNCTION public.update_market_aggregates();


--
-- Name: api_usage api_usage_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.api_usage
    ADD CONSTRAINT api_usage_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: comments comments_market_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_market_id_fkey FOREIGN KEY (market_id) REFERENCES public.markets(id) ON DELETE CASCADE;


--
-- Name: comments comments_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.comments(id) ON DELETE CASCADE;


--
-- Name: comments comments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: market_aggregates market_aggregates_market_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.market_aggregates
    ADD CONSTRAINT market_aggregates_market_id_fkey FOREIGN KEY (market_id) REFERENCES public.markets(id) ON DELETE CASCADE;


--
-- Name: markets markets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.markets
    ADD CONSTRAINT markets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: markets markets_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.markets
    ADD CONSTRAINT markets_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: predictions predictions_market_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_market_id_fkey FOREIGN KEY (market_id) REFERENCES public.markets(id) ON DELETE CASCADE;


--
-- Name: predictions predictions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_accuracy_history user_accuracy_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_accuracy_history
    ADD CONSTRAINT user_accuracy_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict YRf3g81415FKhmdpfTJ0HIPwu1DpQI6iNTkrcOHRg5oIJ9FRn5FazoHGxX8Hpir

