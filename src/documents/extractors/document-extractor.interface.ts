export interface ExtractedGradeItem {
  subject_code?: string;
  subject_name?: string;
  units?: number;
  grade?: number;
  semester?: string;
  [key: string]: unknown;
}

export interface ExtractedResult {
  student_name?: string;
  school_name?: string;
  course_name?: string;
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
