export const ENROLLMENT_COR_DATA_SCHEMA = {
  type: 'object',
  properties: {
    student_name: {
      type: 'string',
      description: "Student's full name printed on the document.",
    },
    student_number: {
      type: 'string',
      description:
        "Student ID or Identification Number (e.g., '2023-12345', '612345').",
    },
    school_name: {
      type: 'string',
      description:
        'Name of the university/college issuing the Certificate of Registration/Matriculation.',
    },
    course_name: {
      type: 'string',
      description:
        "Degree or program title (e.g. 'Bachelor of Science in Information Technology').",
    },
    academic_year: {
      type: 'string',
      description:
        'School Year / Academic Year (e.g., "2026-2027"). Remove prefixes like "A.Y.", "SY".',
    },
    semester: {
      type: 'string',
      description:
        'Term/Semester (e.g., "1st Semester", "2nd Semester", "Summer", "1st Trimester").',
    },
    year_level: {
      type: 'string',
      description:
        'Year level (e.g., "1st Year", "2nd Year", "3rd Year", "4th Year", "1", "2", "3", "4").',
    },
    total_units: {
      type: 'number',
      description: 'Total enrolled credit units for the semester.',
    },
    subjects: {
      type: 'array',
      description: 'List of all registered/enrolled subjects in this term.',
      items: {
        type: 'object',
        properties: {
          subject_code: {
            type: 'string',
            description:
              'Course/Subject Code (e.g. "IT 211", "CCE 102", "MATH 101").',
          },
          descriptive_title: {
            type: 'string',
            description: 'Descriptive title / Course name.',
          },
          section: {
            type: 'string',
            description: 'Section identifier (e.g., "BSIT-2A", "A1", "F1").',
          },
          schedule: {
            type: 'string',
            description:
              'Class schedule/time (e.g., "MWF 8:00-9:00 AM", "TTH 1:00-2:30 PM").',
          },
          room: {
            type: 'string',
            description: 'Room or laboratory location.',
          },
          units: {
            type: 'number',
            description: 'Credit units for the subject (e.g., 3.0, 2.0).',
          },
        },
        required: ['subject_code', 'units'],
      },
    },
  },
  required: ['subjects'],
};

export const ENROLLMENT_SOA_DATA_SCHEMA = {
  type: 'object',
  properties: {
    student_name: {
      type: 'string',
      description:
        "Student's full name printed on the Statement of Account / Ledger.",
    },
    student_number: {
      type: 'string',
      description: 'Student ID / Student Number.',
    },
    school_name: {
      type: 'string',
      description: 'Name of the university / college.',
    },
    academic_year: {
      type: 'string',
      description: 'Academic Year (e.g., "2026-2027").',
    },
    semester: {
      type: 'string',
      description:
        'Term/Semester (e.g., "1st Semester", "2nd Semester", "Summer").',
    },
    assessment_date: {
      type: 'string',
      description:
        'Date of assessment or statement generation (YYYY-MM-DD format if possible).',
    },
    total_assessment: {
      type: 'number',
      description:
        'Total assessment amount / Gross tuition and charges for the term.',
    },
    tuition_fee: {
      type: 'number',
      description: 'Tuition fee portion.',
    },
    lab_fees: {
      type: 'number',
      description: 'Laboratory fees portion.',
    },
    misc_fees: {
      type: 'number',
      description: 'Miscellaneous / Other school fees portion.',
    },
    other_fees: {
      type: 'number',
      description: 'Other charges/fees.',
    },
    previous_balance: {
      type: 'number',
      description:
        'Outstanding balance carried over from previous semesters.',
    },
    discounts: {
      type: 'number',
      description: 'Discounts, scholarships, or deductions applied.',
    },
    net_balance_due: {
      type: 'number',
      description: 'Final remaining net balance due to be paid.',
    },
  },
  required: ['total_assessment'],
};

export const CONSOLIDATED_ENROLLMENT_DATA_SCHEMA = {
  type: 'object',
  properties: {
    student_name: { type: 'string' },
    student_number: { type: 'string' },
    school_name: { type: 'string' },
    course_name: { type: 'string' },
    academic_year: { type: 'string' },
    semester: { type: 'string' },
    year_level: { type: 'string' },
    total_units: { type: 'number' },
    assessment_date: { type: 'string' },
    total_assessment: { type: 'number' },
    tuition_fee: { type: 'number' },
    lab_fees: { type: 'number' },
    misc_fees: { type: 'number' },
    other_fees: { type: 'number' },
    previous_balance: { type: 'number' },
    discounts: { type: 'number' },
    net_balance_due: { type: 'number' },
    subjects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject_code: { type: 'string' },
          descriptive_title: { type: 'string' },
          section: { type: 'string' },
          schedule: { type: 'string' },
          room: { type: 'string' },
          units: { type: 'number' },
        },
        required: ['subject_code', 'units'],
      },
    },
  },
  required: ['subjects', 'total_assessment'],
};
