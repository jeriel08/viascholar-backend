export interface ExtractedGradeItem {
  subject_code?: string;
  subject_name?: string;
  units?: number;
  grade?: number;
  semester?: string;
  [key: string]: unknown;
}

export interface ExtractedGradingLegend {
  legend_title?: string;
  grading_scale?:
    'NUMERIC_5_POINT' | 'NUMERIC_4_POINT' | 'PERCENTAGE_100' | string;
  highest_grade?: number;
  passing_grade?: number;
  failing_grade?: number;
  special_codes?: Record<string, string>;
  notes?: string;
}

export interface ExtractedResult {
  detected_document_type?:
    | 'FORM_138'
    | 'TRANSCRIPT_OF_RECORDS'
    | 'CERTIFICATE_OF_GRADES'
    | 'STATEMENT_OF_ACCOUNT'
    | 'OTHER'
    | string;
  student_name?: string;
  school_name?: string;
  course_name?: string;
  track?: string;
  strand?: string;
  grade_level?: string;
  section?: string;
  has_signature?: boolean | string;
  general_average?: number | null;
  academic_year?: string;
  semester?: string;
  term?: string;
  first_sem_average?: number | null;
  second_sem_average?: number | null;
  grades?: ExtractedGradeItem[];
  grading_legend?: ExtractedGradingLegend | null;
  [key: string]: unknown;
}

export interface InputDocumentFile {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  fileUrl?: string;
}

export interface IDocumentExtractor {
  extractData(
    input: InputDocumentFile | InputDocumentFile[],
    documentType: string,
  ): Promise<ExtractedResult>;
}
