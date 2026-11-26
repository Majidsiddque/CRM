
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

-- Insert 6 courses per institute
INSERT INTO courses (institute_id, name, icon, description, fees, seats_filled)
SELECT
    i.id,
    c.name,
    c.icon,
    c.description,
    c.fees,
    c.seats_filled
FROM institutes i
CROSS JOIN (VALUES
    ('AI & Machine Learning', '🤖', 'Python, data handling and basic ML models with a small project.', '₹24,000', 78),
    ('Full Stack Web', '🌐', 'HTML, CSS, JavaScript, React and a Node backend.', '₹28,000', 92),
    ('Data Analytics', '📊', 'Excel, SQL and dashboards that answer real questions.', '₹18,000', 64),
    ('Cyber Security', '🔐', 'Networks, safe coding and ethical hacking basics.', '₹26,000', 51),
    ('Digital Marketing', '📣', 'SEO, social media and ad campaigns.', '₹14,000', 70),
    ('Spoken English', '🗣️', 'Speaking, writing and interview practice.', '₹8,000', 85)
) AS c(name, icon, description, fees, seats_filled)
WHERE i.id IN (
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;

-- Insert ~40 students per institute
INSERT INTO students (institute_id, name, city, course, status, joined)
SELECT
    i.id,
    names[1 + (g % 30)],
    cities[1 + ((g * 7) % 10)],
    courses[1 + ((g * 13) % 6)],
    statuses[1 + ((g * 3) % 4)],
    CURRENT_DATE - (g * 7 || ' days')::INTERVAL
FROM institutes i
CROSS JOIN generate_series(1, 42) AS g,
LATERAL (VALUES (ARRAY[
    'Pooja Mehta', 'Arjun Das', 'Ananya Iyer', 'Priya Patel', 'Arjun Yadav',
    'Nikhil Yadav', 'Kavya Pandey', 'Ananya Mehta', 'Divya Das', 'Divya Singh',
    'Rahul Singh', 'Anjali Nair', 'Aarav Singh', 'Isha Singh', 'Yash Agarwal',
    'Harsh Kumar', 'Shreya Agarwal', 'Yash Bansal', 'Saanvi Pandey', 'Vihaan Joshi',
    'Priya Chauhan', 'Yash Sharma', 'Siddharth Kumar', 'Shreya Khan', 'Kabir Verma',
    'Meera Gupta', 'Rohan Mishra', 'Tanvi Saxena', 'Dev Tiwari', 'Riya Jain'
])) AS names(names),
LATERAL (VALUES (ARRAY['Agra', 'Mathura', 'Delhi', 'Lucknow', 'Pune', 'Jaipur', 'Indore', 'Meerut', 'Patna', 'Bhopal'])) AS cities(cities),
LATERAL (VALUES (ARRAY['AI & Machine Learning', 'Full Stack Web', 'Data Analytics', 'Cyber Security', 'Digital Marketing', 'Spoken English'])) AS courses(courses),
LATERAL (VALUES (ARRAY['Active', 'Active', 'Pending', 'Inactive'])) AS statuses(statuses)
WHERE i.id IN (
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;

-- Insert 5 enquiries per institute
INSERT INTO enquiries (institute_id, name, course, stage)
SELECT
    i.id,
    e.name,
    e.course,
    e.stage
FROM institutes i
CROSS JOIN (VALUES
    ('Mohit Rawat', 'Full Stack Web', 0),
    ('Sneha Kapoor', 'AI & Machine Learning', 0),
    ('Aditya Roy', 'Data Analytics', 1),
    ('Nisha Bhatt', 'Spoken English', 1),
    ('Karan Malhotra', 'Cyber Security', 2)
) AS e(name, course, stage)
WHERE i.id IN (
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222'
)
ON CONFLICT DO NOTHING;
