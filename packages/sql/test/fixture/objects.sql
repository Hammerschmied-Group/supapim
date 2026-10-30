-- Test fixture (scripts/test-sql.sh): the demo's storage objects as rows, after demo/sql/ created
-- the buckets. In the stack scripts/seed.sh uploads the real files through the Storage API.
insert into storage.objects (bucket_id, name)
select b, n from (values ('images', 'nordwind/regenjacke.png'), ('images', 'nordwind/fleece.png'),
                         ('images', 'suedwind/sonnencreme.png'), ('images', 'suedwind/after-sun.png'),
                         ('hr-files', 'handbuch/onboarding.md'), ('hr-files', 'handbuch/urlaubsregelung.md')) v(b, n)
 where not exists (select 1 from storage.objects o where o.bucket_id = v.b and o.name = v.n);
