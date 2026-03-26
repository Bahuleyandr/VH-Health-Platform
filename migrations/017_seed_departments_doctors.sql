-- Seed departments for Venkataeswara Hospitals
INSERT INTO departments (name, description, contact_number, location, is_active) VALUES
  ('Cardiology', 'Heart and cardiovascular disease treatment. Angiography, angioplasty, pacemaker implantation, cardiac rehabilitation.', '044-4511 4511', 'Block A, 2nd Floor', true),
  ('Neurology', 'Brain, spinal cord and nervous system disorders. Stroke care, epilepsy management, headache clinic.', '044-4511 4511', 'Block A, 3rd Floor', true),
  ('Orthopaedics', 'Bone, joint and musculoskeletal treatments. Joint replacement, fracture management, sports medicine.', '044-4511 4511', 'Block B, 1st Floor', true),
  ('General Medicine', 'Primary healthcare and internal medicine. Diabetes management, hypertension, infectious diseases.', '044-4511 4511', 'Block A, Ground Floor', true),
  ('General Surgery', 'Surgical procedures for abdominal, thyroid, hernia and other conditions. Minimally invasive surgery.', '044-4511 4511', 'Block B, 2nd Floor', true),
  ('Obstetrics & Gynaecology', 'Women''s health, pregnancy care, delivery, gynaecological surgeries. High-risk pregnancy management.', '044-4511 4511', 'Block C, 1st Floor', true),
  ('Paediatrics', 'Child healthcare from newborn to adolescent. Neonatal ICU, vaccinations, growth monitoring.', '044-4511 4511', 'Block C, Ground Floor', true),
  ('Dermatology', 'Skin, hair and nail disorders. Cosmetology, laser treatments, allergy testing.', '044-4511 4511', 'Block A, 1st Floor', true),
  ('ENT (Otorhinolaryngology)', 'Ear, nose and throat treatments. Sinus surgery, hearing aids, vertigo management.', '044-4511 4511', 'Block B, 3rd Floor', true),
  ('Ophthalmology', 'Eye care and vision correction. Cataract surgery, glaucoma treatment, retinal procedures.', '044-4511 4511', 'Block A, 1st Floor', true),
  ('Nephrology', 'Kidney disease treatment and dialysis. Kidney transplant evaluation, chronic kidney disease management.', '044-4511 4511', 'Block B, Ground Floor', true),
  ('Urology', 'Urinary tract and male reproductive system. Kidney stone treatment, prostate care, urological cancers.', '044-4511 4511', 'Block B, 2nd Floor', true),
  ('Pulmonology', 'Lung and respiratory diseases. Asthma, COPD, sleep apnoea, tuberculosis care.', '044-4511 4511', 'Block A, 2nd Floor', true),
  ('Gastroenterology', 'Digestive system disorders. Endoscopy, colonoscopy, liver disease, IBD management.', '044-4511 4511', 'Block B, 1st Floor', true),
  ('Oncology', 'Cancer diagnosis and treatment. Chemotherapy, targeted therapy, tumour board review.', '044-4511 4511', 'Block C, 2nd Floor', true),
  ('Psychiatry', 'Mental health services. Depression, anxiety, addiction counselling, cognitive behavioural therapy.', '044-4511 4511', 'Block A, 3rd Floor', true),
  ('Physiotherapy & Rehabilitation', 'Physical therapy, post-surgical rehabilitation, sports injury recovery, pain management.', '044-4511 4511', 'Block C, Ground Floor', true),
  ('Emergency Medicine', '24/7 emergency and trauma care. Accident and emergency, critical care, poison management.', '044-4500 4500', 'Main Building, Ground Floor', true),
  ('Radiology & Imaging', 'Diagnostic imaging services. MRI, CT scan, X-ray, ultrasound, PET-CT.', '044-4511 4511', 'Block A, Basement', true),
  ('Pathology & Lab', 'Laboratory testing and diagnostics. Blood tests, biopsies, microbiology, histopathology.', '044-4511 4511', 'Block A, Basement', true)
ON CONFLICT (name) DO NOTHING;

-- Create user accounts for doctors (they need a users entry first)
INSERT INTO users (phone, name, role, is_active) VALUES
  ('9000000001', 'Dr. Thillai Vallal', 'DOCTOR', true),
  ('9000000002', 'Dr. Priya Venkatesh', 'DOCTOR', true),
  ('9000000003', 'Dr. Suresh Kumar', 'DOCTOR', true),
  ('9000000004', 'Dr. Lakshmi Narayanan', 'DOCTOR', true),
  ('9000000005', 'Dr. Anand Raghavan', 'DOCTOR', true),
  ('9000000006', 'Dr. Meenakshi Sundaram', 'DOCTOR', true),
  ('9000000007', 'Dr. Rajesh Kannan', 'DOCTOR', true),
  ('9000000008', 'Dr. Deepa Krishnan', 'DOCTOR', true),
  ('9000000009', 'Dr. Karthik Subramanian', 'DOCTOR', true),
  ('9000000010', 'Dr. Revathi Shankar', 'DOCTOR', true),
  ('9000000011', 'Dr. Balaji Natarajan', 'DOCTOR', true),
  ('9000000012', 'Dr. Saranya Devi', 'DOCTOR', true),
  ('9000000013', 'Dr. Ganesh Iyer', 'DOCTOR', true),
  ('9000000014', 'Dr. Vidya Ramesh', 'DOCTOR', true),
  ('9000000015', 'Dr. Aravind Mohan', 'DOCTOR', true),
  ('9000000016', 'Dr. Shanti Priya', 'DOCTOR', true),
  ('9000000017', 'Dr. Manikandan S', 'DOCTOR', true),
  ('9000000018', 'Dr. Padmini Rao', 'DOCTOR', true),
  ('9000000019', 'Dr. Senthil Murugan', 'DOCTOR', true),
  ('9000000020', 'Dr. Kavitha Balan', 'DOCTOR', true)
ON CONFLICT (phone) DO NOTHING;

-- Create doctor profiles linked to departments
DO $$
DECLARE
  dept_cardiology INTEGER;
  dept_neurology INTEGER;
  dept_ortho INTEGER;
  dept_genmed INTEGER;
  dept_gensurg INTEGER;
  dept_obgyn INTEGER;
  dept_paed INTEGER;
  dept_derm INTEGER;
  dept_ent INTEGER;
  dept_ophthal INTEGER;
  dept_nephro INTEGER;
  dept_uro INTEGER;
  dept_pulm INTEGER;
  dept_gastro INTEGER;
  dept_onco INTEGER;
  dept_psych INTEGER;
  dept_physio INTEGER;
  dept_emergency INTEGER;
  dept_radio INTEGER;
  dept_path INTEGER;
BEGIN
  SELECT id INTO dept_cardiology FROM departments WHERE name='Cardiology';
  SELECT id INTO dept_neurology FROM departments WHERE name='Neurology';
  SELECT id INTO dept_ortho FROM departments WHERE name='Orthopaedics';
  SELECT id INTO dept_genmed FROM departments WHERE name='General Medicine';
  SELECT id INTO dept_gensurg FROM departments WHERE name='General Surgery';
  SELECT id INTO dept_obgyn FROM departments WHERE name='Obstetrics & Gynaecology';
  SELECT id INTO dept_paed FROM departments WHERE name='Paediatrics';
  SELECT id INTO dept_derm FROM departments WHERE name='Dermatology';
  SELECT id INTO dept_ent FROM departments WHERE name='ENT (Otorhinolaryngology)';
  SELECT id INTO dept_ophthal FROM departments WHERE name='Ophthalmology';
  SELECT id INTO dept_nephro FROM departments WHERE name='Nephrology';
  SELECT id INTO dept_uro FROM departments WHERE name='Urology';
  SELECT id INTO dept_pulm FROM departments WHERE name='Pulmonology';
  SELECT id INTO dept_gastro FROM departments WHERE name='Gastroenterology';
  SELECT id INTO dept_onco FROM departments WHERE name='Oncology';
  SELECT id INTO dept_psych FROM departments WHERE name='Psychiatry';
  SELECT id INTO dept_physio FROM departments WHERE name='Physiotherapy & Rehabilitation';
  SELECT id INTO dept_emergency FROM departments WHERE name='Emergency Medicine';
  SELECT id INTO dept_radio FROM departments WHERE name='Radiology & Imaging';
  SELECT id INTO dept_path FROM departments WHERE name='Pathology & Lab';

  INSERT INTO doctors (user_id, department_id, specialization, department, experience_years, consultation_fee, available_days, available_hours, is_available, bio, education, qualifications) VALUES
    ((SELECT id FROM users WHERE phone='9000000001'), dept_cardiology, 'Interventional Cardiology', 'Cardiology', 25, 1000.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], '{"Monday":{"start":"09:00","end":"17:00"},"Tuesday":{"start":"09:00","end":"17:00"},"Wednesday":{"start":"09:00","end":"17:00"},"Thursday":{"start":"09:00","end":"17:00"},"Friday":{"start":"09:00","end":"17:00"},"Saturday":{"start":"09:00","end":"13:00"}}'::jsonb, true, 'Founder & Chairman. Over 25 years of experience in interventional cardiology. Performed 50,000+ cardiac procedures.', 'MD (General Medicine), DM (Cardiology) - Madras Medical College', ARRAY['MBBS','MD','DM Cardiology','FESC','FACC']),
    ((SELECT id FROM users WHERE phone='9000000002'), dept_cardiology, 'Clinical Cardiology', 'Cardiology', 15, 800.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"10:00","end":"16:00"},"Tuesday":{"start":"10:00","end":"16:00"},"Wednesday":{"start":"10:00","end":"16:00"},"Thursday":{"start":"10:00","end":"16:00"},"Friday":{"start":"10:00","end":"16:00"}}'::jsonb, true, 'Senior Consultant in Clinical Cardiology. Expertise in heart failure management and preventive cardiology.', 'MD (Internal Medicine), DM (Cardiology) - CMC Vellore', ARRAY['MBBS','MD','DM Cardiology']),
    ((SELECT id FROM users WHERE phone='9000000003'), dept_neurology, 'Neurology & Stroke', 'Neurology', 18, 900.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], '{"Monday":{"start":"09:30","end":"16:30"},"Tuesday":{"start":"09:30","end":"16:30"},"Wednesday":{"start":"09:30","end":"16:30"},"Thursday":{"start":"09:30","end":"16:30"},"Friday":{"start":"09:30","end":"16:30"},"Saturday":{"start":"09:30","end":"13:00"}}'::jsonb, true, 'Head of Neurology. Specialist in stroke management and epilepsy.', 'DM (Neurology) - NIMHANS Bangalore', ARRAY['MBBS','MD','DM Neurology']),
    ((SELECT id FROM users WHERE phone='9000000004'), dept_ortho, 'Joint Replacement Surgery', 'Orthopaedics', 20, 800.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"09:00","end":"15:00"},"Tuesday":{"start":"09:00","end":"15:00"},"Wednesday":{"start":"09:00","end":"15:00"},"Thursday":{"start":"09:00","end":"15:00"},"Friday":{"start":"09:00","end":"15:00"}}'::jsonb, true, 'Senior Orthopaedic Surgeon. 3000+ joint replacements performed.', 'MS (Orthopaedics) - Stanley Medical College', ARRAY['MBBS','MS Ortho','Fellowship Joint Replacement (Germany)']),
    ((SELECT id FROM users WHERE phone='9000000005'), dept_genmed, 'Internal Medicine & Diabetology', 'General Medicine', 22, 500.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], '{"Monday":{"start":"08:00","end":"17:00"},"Tuesday":{"start":"08:00","end":"17:00"},"Wednesday":{"start":"08:00","end":"17:00"},"Thursday":{"start":"08:00","end":"17:00"},"Friday":{"start":"08:00","end":"17:00"},"Saturday":{"start":"08:00","end":"13:00"}}'::jsonb, true, 'Chief of Internal Medicine. Specialises in diabetes and metabolic disorders.', 'MD (Internal Medicine) - Madras Medical College', ARRAY['MBBS','MD Internal Medicine','Fellowship Diabetology']),
    ((SELECT id FROM users WHERE phone='9000000006'), dept_gensurg, 'Laparoscopic & General Surgery', 'General Surgery', 16, 700.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"09:00","end":"16:00"},"Tuesday":{"start":"09:00","end":"16:00"},"Wednesday":{"start":"09:00","end":"16:00"},"Thursday":{"start":"09:00","end":"16:00"},"Friday":{"start":"09:00","end":"16:00"}}'::jsonb, true, 'Specialist in minimally invasive surgery. Expert in hernia, gallbladder and thyroid surgery.', 'MS (General Surgery) - Government General Hospital Chennai', ARRAY['MBBS','MS General Surgery','Fellowship MIS']),
    ((SELECT id FROM users WHERE phone='9000000007'), dept_obgyn, 'Obstetrics & High-Risk Pregnancy', 'Obstetrics & Gynaecology', 19, 700.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], '{"Monday":{"start":"09:00","end":"16:00"},"Tuesday":{"start":"09:00","end":"16:00"},"Wednesday":{"start":"09:00","end":"16:00"},"Thursday":{"start":"09:00","end":"16:00"},"Friday":{"start":"09:00","end":"16:00"},"Saturday":{"start":"09:00","end":"12:00"}}'::jsonb, true, 'Senior OB-GYN. Expert in high-risk pregnancies and gynaecological laparoscopy.', 'MD (OBG), DGO - Kilpauk Medical College', ARRAY['MBBS','DGO','MD OBG']),
    ((SELECT id FROM users WHERE phone='9000000008'), dept_paed, 'Paediatrics & Neonatology', 'Paediatrics', 14, 600.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], '{"Monday":{"start":"09:00","end":"17:00"},"Tuesday":{"start":"09:00","end":"17:00"},"Wednesday":{"start":"09:00","end":"17:00"},"Thursday":{"start":"09:00","end":"17:00"},"Friday":{"start":"09:00","end":"17:00"},"Saturday":{"start":"09:00","end":"13:00"}}'::jsonb, true, 'Consultant Paediatrician. Specialises in newborn care and childhood infections.', 'MD (Paediatrics) - ICH Chennai', ARRAY['MBBS','MD Paediatrics','IAP Fellowship Neonatology']),
    ((SELECT id FROM users WHERE phone='9000000009'), dept_derm, 'Dermatology & Cosmetology', 'Dermatology', 12, 600.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"10:00","end":"16:00"},"Tuesday":{"start":"10:00","end":"16:00"},"Wednesday":{"start":"10:00","end":"16:00"},"Thursday":{"start":"10:00","end":"16:00"},"Friday":{"start":"10:00","end":"16:00"}}'::jsonb, true, 'Consultant Dermatologist. Laser treatments, acne management, hair restoration.', 'MD (Dermatology) - Madras Medical College', ARRAY['MBBS','MD Dermatology','Fellowship Cosmetic Dermatology']),
    ((SELECT id FROM users WHERE phone='9000000010'), dept_ent, 'ENT Surgery', 'ENT (Otorhinolaryngology)', 17, 600.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"09:00","end":"15:00"},"Tuesday":{"start":"09:00","end":"15:00"},"Wednesday":{"start":"09:00","end":"15:00"},"Thursday":{"start":"09:00","end":"15:00"},"Friday":{"start":"09:00","end":"15:00"}}'::jsonb, true, 'Head of ENT. Expert in sinus surgery, cochlear implants, and head & neck oncology.', 'MS (ENT) - Government ENT Hospital Chennai', ARRAY['MBBS','MS ENT','Fellowship Head & Neck Surgery']),
    ((SELECT id FROM users WHERE phone='9000000011'), dept_ophthal, 'Ophthalmology & Retina', 'Ophthalmology', 15, 500.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], '{"Monday":{"start":"09:00","end":"16:00"},"Tuesday":{"start":"09:00","end":"16:00"},"Wednesday":{"start":"09:00","end":"16:00"},"Thursday":{"start":"09:00","end":"16:00"},"Friday":{"start":"09:00","end":"16:00"},"Saturday":{"start":"09:00","end":"12:00"}}'::jsonb, true, 'Senior Eye Surgeon. Cataract, LASIK, retinal detachment, glaucoma management.', 'MS (Ophthalmology) - Sankara Nethralaya', ARRAY['MBBS','MS Ophthalmology','Fellowship Retina']),
    ((SELECT id FROM users WHERE phone='9000000012'), dept_nephro, 'Nephrology & Transplant', 'Nephrology', 13, 800.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"10:00","end":"16:00"},"Tuesday":{"start":"10:00","end":"16:00"},"Wednesday":{"start":"10:00","end":"16:00"},"Thursday":{"start":"10:00","end":"16:00"},"Friday":{"start":"10:00","end":"16:00"}}'::jsonb, true, 'Consultant Nephrologist. Dialysis management, kidney transplant evaluation.', 'DM (Nephrology) - Government General Hospital Chennai', ARRAY['MBBS','MD','DM Nephrology']),
    ((SELECT id FROM users WHERE phone='9000000013'), dept_gastro, 'Gastroenterology & Hepatology', 'Gastroenterology', 16, 800.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"09:30","end":"16:30"},"Tuesday":{"start":"09:30","end":"16:30"},"Wednesday":{"start":"09:30","end":"16:30"},"Thursday":{"start":"09:30","end":"16:30"},"Friday":{"start":"09:30","end":"16:30"}}'::jsonb, true, 'Senior Gastroenterologist. Endoscopy, colonoscopy, liver disease specialist.', 'DM (Gastroenterology) - CMC Vellore', ARRAY['MBBS','MD','DM Gastroenterology']),
    ((SELECT id FROM users WHERE phone='9000000014'), dept_pulm, 'Pulmonology & Sleep Medicine', 'Pulmonology', 14, 700.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"09:00","end":"15:00"},"Tuesday":{"start":"09:00","end":"15:00"},"Wednesday":{"start":"09:00","end":"15:00"},"Thursday":{"start":"09:00","end":"15:00"},"Friday":{"start":"09:00","end":"15:00"}}'::jsonb, true, 'Consultant Pulmonologist. Asthma, COPD, sleep apnoea, interventional pulmonology.', 'DM (Pulmonology) - Madras Medical College', ARRAY['MBBS','MD','DM Pulmonary Medicine']),
    ((SELECT id FROM users WHERE phone='9000000015'), dept_onco, 'Medical Oncology', 'Oncology', 12, 1000.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"09:00","end":"16:00"},"Tuesday":{"start":"09:00","end":"16:00"},"Wednesday":{"start":"09:00","end":"16:00"},"Thursday":{"start":"09:00","end":"16:00"},"Friday":{"start":"09:00","end":"16:00"}}'::jsonb, true, 'Consultant Oncologist. Chemotherapy, targeted therapy, immunotherapy protocols.', 'DM (Medical Oncology) - Cancer Institute Adyar', ARRAY['MBBS','MD','DM Medical Oncology']),
    ((SELECT id FROM users WHERE phone='9000000016'), dept_uro, 'Urology & Andrology', 'Urology', 18, 700.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"10:00","end":"16:00"},"Tuesday":{"start":"10:00","end":"16:00"},"Wednesday":{"start":"10:00","end":"16:00"},"Thursday":{"start":"10:00","end":"16:00"},"Friday":{"start":"10:00","end":"16:00"}}'::jsonb, true, 'Senior Urologist. Kidney stones, prostate surgery, urological laparoscopy.', 'MCh (Urology) - Madras Medical College', ARRAY['MBBS','MS','MCh Urology']),
    ((SELECT id FROM users WHERE phone='9000000017'), dept_psych, 'Psychiatry & Counselling', 'Psychiatry', 10, 600.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday'], '{"Monday":{"start":"10:00","end":"16:00"},"Tuesday":{"start":"10:00","end":"16:00"},"Wednesday":{"start":"10:00","end":"16:00"},"Thursday":{"start":"10:00","end":"16:00"},"Friday":{"start":"10:00","end":"16:00"}}'::jsonb, true, 'Consultant Psychiatrist. Depression, anxiety, OCD, addiction counselling.', 'MD (Psychiatry) - Institute of Mental Health Chennai', ARRAY['MBBS','MD Psychiatry']),
    ((SELECT id FROM users WHERE phone='9000000018'), dept_physio, 'Physiotherapy', 'Physiotherapy & Rehabilitation', 8, 400.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], '{"Monday":{"start":"08:00","end":"17:00"},"Tuesday":{"start":"08:00","end":"17:00"},"Wednesday":{"start":"08:00","end":"17:00"},"Thursday":{"start":"08:00","end":"17:00"},"Friday":{"start":"08:00","end":"17:00"},"Saturday":{"start":"08:00","end":"13:00"}}'::jsonb, true, 'Senior Physiotherapist. Post-surgical rehab, sports injuries, chronic pain.', 'MPT (Orthopaedics) - SRM University', ARRAY['BPT','MPT Orthopaedics']),
    ((SELECT id FROM users WHERE phone='9000000019'), dept_emergency, 'Emergency & Critical Care', 'Emergency Medicine', 15, 500.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], '{"Monday":{"start":"00:00","end":"23:59"},"Tuesday":{"start":"00:00","end":"23:59"},"Wednesday":{"start":"00:00","end":"23:59"},"Thursday":{"start":"00:00","end":"23:59"},"Friday":{"start":"00:00","end":"23:59"},"Saturday":{"start":"00:00","end":"23:59"},"Sunday":{"start":"00:00","end":"23:59"}}'::jsonb, true, 'Head of Emergency Medicine. 24/7 trauma and critical care.', 'MD (Emergency Medicine) - AIIMS', ARRAY['MBBS','MD Emergency Medicine','ACLS Instructor']),
    ((SELECT id FROM users WHERE phone='9000000020'), dept_genmed, 'General Medicine', 'General Medicine', 10, 400.00, ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'], '{"Monday":{"start":"09:00","end":"17:00"},"Tuesday":{"start":"09:00","end":"17:00"},"Wednesday":{"start":"09:00","end":"17:00"},"Thursday":{"start":"09:00","end":"17:00"},"Friday":{"start":"09:00","end":"17:00"},"Saturday":{"start":"09:00","end":"13:00"}}'::jsonb, true, 'Consultant Physician. General checkups, fever clinic, lifestyle disease management.', 'MD (General Medicine) - Govt General Hospital', ARRAY['MBBS','MD General Medicine'])
  ON CONFLICT (user_id) DO NOTHING;
END $$;
