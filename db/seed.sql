
-- Insert two institutes
INSERT INTO institutes (id, name)
VALUES
(
    '11111111-1111-1111-1111-111111111111',
    'instA'
),
(
    '22222222-2222-2222-2222-222222222222',
    'instB'
)
ON CONFLICT (id) DO NOTHING;

-- Insert exactly 1000 people per institute
INSERT INTO people (institute_id, name, email)
SELECT
    i.id,
    'Person_' || g,
    'person_' || g || '@' ||
    lower(replace(i.name, ' ', '')) || '.com'
FROM institutes i
CROSS JOIN generate_series(1, 1000) AS g
WHERE i.id IN (
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;
