-- Rename sex column to gender on employees and scholar_profiles safely
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'employees'
      AND column_name = 'sex'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'employees'
      AND column_name = 'gender'
  ) THEN
    ALTER TABLE "employees" RENAME COLUMN "sex" TO "gender";
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'scholar_profiles'
      AND column_name = 'sex'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'scholar_profiles'
      AND column_name = 'gender'
  ) THEN
    ALTER TABLE "scholar_profiles" RENAME COLUMN "sex" TO "gender";
  END IF;
END $$;
