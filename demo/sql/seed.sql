-- Demo data. Deterministic (fixed ids, no random()), so every reset yields the same rows.
-- Fictional brands and texts only — no production data. Run as supabase_admin after 00–40.
-- Expects the test users created by scripts/seed.sh (GoTrue admin API, fixed ids).

begin;

-- Brand settings (the row exists: the brand bootstrap created it) --------------------------------
update nordwind.settings set website_url = 'https://nordwind.example', contact_email = 'service@nordwind.example',
       default_locale = 'de-DE', seo_title_suffix = ' | Nordwind', seo_description = 'Funktionskleidung für Küste und Berg.';
update suedwind.settings set website_url = 'https://suedwind.example', contact_email = 'hallo@suedwind.example',
       default_locale = 'de-DE', seo_title_suffix = ' | Südwind', seo_description = 'Sonnenschutz und Pflege für jeden Hauttyp.';

-- Products ----------------------------------------------------------------------------------
insert into nordwind.products (id, sku, name, description, price) values
  ('10000000-0000-4000-8000-000000000001', 'NW-1001', 'Nordwind Regenjacke Classic',  'Leichte, wasserdichte Jacke für Küstenwetter.', 129.00),
  ('10000000-0000-4000-8000-000000000002', 'NW-1002', 'Nordwind Fleece Midlayer',     'Warmer Fleece aus recyceltem Polyester.',       69.90),
  ('10000000-0000-4000-8000-000000000003', 'NW-1003', 'Nordwind Wollmütze',           'Merino-Mütze, kratzfrei.',                      24.50);
insert into suedwind.products (id, sku, name, description, price) values
  ('20000000-0000-4000-8000-000000000001', 'SW-2001', 'Südwind Sonnencreme LSF 50',   'Mineralischer Sonnenschutz, parfümfrei.',       18.90),
  ('20000000-0000-4000-8000-000000000002', 'SW-2002', 'Südwind After-Sun Gel',        'Kühlendes Gel mit Aloe vera.',                  12.50),
  ('20000000-0000-4000-8000-000000000003', 'SW-2003', 'Südwind Lippenpflege LSF 30',  'Pflegestift mit Sheabutter.',                    4.95);

insert into nordwind.product_images (id, product_id, storage_path, alt_text, title_attr, position) values
  ('11000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'nordwind/regenjacke.png', 'Regenjacke in Marineblau', 'Nordwind Regenjacke Classic', 0),
  ('11000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'nordwind/fleece.png',     'Fleece-Jacke in Grau',     'Nordwind Fleece Midlayer',    0);
insert into suedwind.product_images (id, product_id, storage_path, alt_text, title_attr, position) values
  ('21000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'suedwind/sonnencreme.png', 'Tube Sonnencreme',  'Südwind Sonnencreme LSF 50', 0),
  ('21000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'suedwind/after-sun.png',   'Flasche After-Sun', 'Südwind After-Sun Gel',      0);

insert into nordwind.faq (id, question, answer, position) values
  ('12000000-0000-4000-8000-000000000001', 'Wie wasche ich die Regenjacke?', 'Bei 30 °C im Schonwaschgang, ohne Weichspüler.', 0),
  ('12000000-0000-4000-8000-000000000002', 'Wie lange dauert der Versand?',  '2–3 Werktage innerhalb Deutschlands.',            1);
insert into suedwind.faq (id, question, answer, position) values
  ('22000000-0000-4000-8000-000000000001', 'Ist die Sonnencreme wasserfest?',   'Ja, bis zu 40 Minuten im Wasser.',            0),
  ('22000000-0000-4000-8000-000000000002', 'Ist das Produkt für Kinder geeignet?', 'Ab 3 Jahren, bitte Hautverträglichkeit testen.', 1);

-- Vector store: pseudo-embeddings from sin(i * seed) — deterministic, distinct, no model needed.
insert into public.documents (brand, content, metadata, embedding)
select d.brand, d.content, d.metadata,
       (select array_agg(sin(i * d.seed)::real order by i) from generate_series(1, 1536) i)::extensions.vector
  from (values
    ('nordwind', 'Die Regenjacke Classic hat eine Wassersäule von 10.000 mm.', '{"source":"pim","sku":"NW-1001"}'::jsonb, 0.11),
    ('nordwind', 'Fleece Midlayer: 100 % recyceltes Polyester, 280 g/m².',      '{"source":"pim","sku":"NW-1002"}'::jsonb, 0.23),
    ('suedwind', 'Sonnencreme LSF 50 enthält ausschließlich mineralische Filter.', '{"source":"pim","sku":"SW-2001"}'::jsonb, 0.37),
    ('suedwind', 'After-Sun Gel kühlt durch Aloe vera und Menthol.',             '{"source":"faq"}'::jsonb,                0.41),
    ('hr',       'Urlaubsanträge werden spätestens vier Wochen vorher gestellt.', '{"source":"hr","file":"handbuch/urlaubsregelung.md"}'::jsonb, 0.53),
    ('hr',       'Neue Mitarbeitende erhalten am ersten Tag Laptop und Zugänge.', '{"source":"hr","file":"handbuch/onboarding.md"}'::jsonb,     0.67)
  ) as d(brand, content, metadata, seed);

-- Test users → roles (users are created by scripts/seed.sh with these fixed ids) -------------
insert into cms.user_roles (user_id, db_role, granted_by) values
  ('00000000-0000-4000-8000-000000000001', 'cms_admin',       'seed'),
  ('00000000-0000-4000-8000-000000000002', 'agency_nordwind', 'seed'),
  ('00000000-0000-4000-8000-000000000003', 'agency_suedwind', 'seed'),
  ('00000000-0000-4000-8000-000000000004', 'hr_editor',       'seed');
-- 00000000-0000-4000-8000-000000000005 (ohne.rolle@example.com) deliberately has no mapping.

commit;
