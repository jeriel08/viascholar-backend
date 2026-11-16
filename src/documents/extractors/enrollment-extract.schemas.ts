export const ENROLLMENT_COR_DATA_SCHEMA = {
  type: 'object',
  properties: {
    detected_document_type: {
      type: 'string',
      enum: [
        'CERTIFICATE_OF_REGISTRATION',
        'STATEMENT_OF_ACCOUNT',
        'CONSOLIDATED_ENROLLMENT',
        'OTHER',
      ],
      description:
        "Document classification. 'CERTIFICATE_OF_REGISTRATION' for Certificate of Registration / Matriculation / Class Schedule / Study Load listing courses; 'STATEMENT_OF_ACCOUNT' for tuition billing, student ledgers, fee assessments; 'CONSOLIDATED_ENROLLMENT' if the form has BOTH class schedule and tuition assessment; 'OTHER' for unrelated documents.",
    },
    is_class_schedule: {
      type: 'boolean',
      description:
        'True ONLY if the document explicitly contains an enrolled subjects / course schedule table with subjects and units.',
    },
    is_assessment_form: {
      type: 'boolean',
      description:
        'True if this document is primarily a tuition fee assessment, billing statement, student ledger, or cashier assessment of fees.',
    },
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
        'School Year / Academic Year printed on the document. If a range is shown (e.g., "2023-2024", "2023-24", "2024-25"), expand to full 4-digit years (e.g., "2023-2024", "2024-2025"). CRITICAL FOR SUMMER / MIDYEAR: If a single year is printed with Summer/Midyear (e.g., "Summer 2024", "Summer 2026", "Midyear 2024"), extract the exact 4-digit year (e.g., "2024", "2026"). Remove prefixes like "A.Y.", "SY". NEVER invent a year not printed on the document.',
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
              'Alphanumeric Course/Subject Code (e.g. "GE 5", "GE 11", "GE 20", "IT 211", "CCE 102", "UGE 1", "PAHF 2", "MATH 101"). CRITICAL: On university portal Class Schedules with columns [Code | Title | Description], the "Code" column is a 4-5 digit numeric class/section code (e.g. "11040", "11065", "6471") and the "Title" column is the actual Subject Code (e.g. "GE 5", "GE 11", "UGE 1"). Always extract the alphanumeric "Title" column as subject_code, and put the numeric "Code" column into section!',
          },
          descriptive_title: {
            type: 'string',
            description:
              'Descriptive title / Course name (e.g. "SCIENCE, TECHNOLOGY AND SOCIETY", "THE ENTREPRENEURIAL MINDS", "READING VISUAL ARTS"). In tables with [Code | Title | Description], extract ONLY the "Description" column here — do NOT prepend the subject code from the "Title" column.',
          },
          section: {
            type: 'string',
            description:
              'Section identifier or numeric class offering code (e.g., "11040", "11065", "6471", "BSIT-2A", "A1", "F1").',
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
  required: ['detected_document_type'],
};

export const ENROLLMENT_SOA_DATA_SCHEMA = {
  type: 'object',
  properties: {
    detected_document_type: {
      type: 'string',
      enum: [
        'CERTIFICATE_OF_REGISTRATION',
        'STATEMENT_OF_ACCOUNT',
        'CONSOLIDATED_ENROLLMENT',
        'OTHER',
      ],
      description:
        "Document classification. 'STATEMENT_OF_ACCOUNT' for tuition billing, student ledgers, fee assessments; 'CERTIFICATE_OF_REGISTRATION' for Certificate of Registration / Class Schedule; 'CONSOLIDATED_ENROLLMENT' if the form has BOTH class schedule and tuition assessment; 'OTHER' for unrelated documents.",
    },
    is_class_schedule: {
      type: 'boolean',
      description:
        'True ONLY if the document explicitly contains an enrolled subjects / course schedule table with subjects and units.',
    },
    is_assessment_form: {
      type: 'boolean',
      description:
        'True if this document contains tuition fees, fee breakdown, or assessment of tuition balance due.',
    },
    has_itemized_breakdown: {
      type: 'boolean',
      description:
        'True ONLY if the document displays an itemized breakdown of fees (e.g., Tuition Fee, Miscellaneous Fees, Laboratory Fees, Other Fees, or itemized charge lines). Set to FALSE if it is only a portal summary screenshot showing a total balance without itemized fee details.',
    },
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
      description:
        'School Year / Academic Year printed on the document. If a range is shown (e.g., "2023-2024", "2023-24", "2024-25"), expand to full 4-digit years (e.g., "2023-2024", "2024-2025"). CRITICAL FOR SUMMER / MIDYEAR: If a single year is printed with Summer/Midyear (e.g., "Summer 2024", "Summer 2026", "Midyear 2024"), extract the exact 4-digit year (e.g., "2024", "2026"). NEVER invent a year not printed on the document.',
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
      description: 'Outstanding balance carried over from previous semesters.',
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
  required: ['detected_document_type'],
};

export const CONSOLIDATED_ENROLLMENT_DATA_SCHEMA = {
  type: 'object',
  properties: {
    detected_document_type: {
      type: 'string',
      enum: [
        'CERTIFICATE_OF_REGISTRATION',
        'STATEMENT_OF_ACCOUNT',
        'CONSOLIDATED_ENROLLMENT',
        'OTHER',
      ],
      description:
        "Document classification. Should be 'CONSOLIDATED_ENROLLMENT' if both class schedule and tuition assessment are present on this document.",
    },
    is_class_schedule: { type: 'boolean' },
    is_assessment_form: { type: 'boolean' },
    student_name: { type: 'string' },
    student_number: { type: 'string' },
    school_name: { type: 'string' },
    course_name: { type: 'string' },
    academic_year: {
      type: 'string',
      description:
        'School Year / Academic Year printed on the document (e.g. "2023-2024", or single 4-digit year "2024" for "Summer 2024").',
    },
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
          subject_code: {
            type: 'string',
            description:
              'Alphanumeric Course/Subject Code (e.g. "GE 5", "GE 11", "IT 101"). In [Code | Title | Description] tables, extract "Title" as subject_code and put the numeric "Code" in section.',
          },
          descriptive_title: {
            type: 'string',
            description:
              'Descriptive title of the course without repeating the subject_code.',
          },
          section: { type: 'string' },
          schedule: { type: 'string' },
          room: { type: 'string' },
          units: { type: 'number' },
        },
        required: ['subject_code', 'units'],
      },
    },
  },
  required: ['detected_document_type'],
};
