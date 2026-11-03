import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlamaCloud, toFile } from '@llamaindex/llama-cloud';
import { PDFDocument } from 'pdf-lib';
import {
  ExtractedResult,
  IDocumentExtractor,
  InputDocumentFile,
} from './document-extractor.interface.js';
import {
  ENROLLMENT_COR_DATA_SCHEMA,
  ENROLLMENT_SOA_DATA_SCHEMA,
  CONSOLIDATED_ENROLLMENT_DATA_SCHEMA,
} from './enrollment-extract.schemas.js';
import {
  OFFICIAL_RECEIPT_DATA_SCHEMA,
  type ExtractedReceiptData,
} from './receipt-extract.schemas.js';

const DOCUMENT_DATA_SCHEMA = {
  type: 'object',
  properties: {
    detected_document_type: {
      type: 'string',
      enum: [
        'FORM_138',
        'TRANSCRIPT_OF_RECORDS',
        'CERTIFICATE_OF_GRADES',
        'STATEMENT_OF_ACCOUNT',
        'CERTIFICATE_OF_REGISTRATION',
        'OTHER',
      ],
      description:
        "Classification of the document. 'FORM_138' for DepEd Form 138 / SF9-SHS / SF9-JHS / Form 9 / Form 137 / Progress Report Card; 'TRANSCRIPT_OF_RECORDS' for College Official Transcript of Records (TOR); 'CERTIFICATE_OF_GRADES' for Certified Copy of Grades (COG) / CCG / Grade Slip; 'STATEMENT_OF_ACCOUNT' for billing statements / tuition assessments; 'CERTIFICATE_OF_REGISTRATION' for Certificate of Registration (COR) / Certificate of Matriculation (COM) / Class Schedule; 'OTHER' for unrelated or other documents.",
    },
    student_name: {
      type: 'string',
      description:
        "Student's full name from the document. Format as 'LAST NAME, FIRST NAME MIDDLE NAME' or 'FIRST NAME LAST NAME'.",
    },
    school_name: {
      type: 'string',
      description:
        'Name of the college, university, or high school issuing the document.',
    },
    course_name: {
      type: 'string',
      description:
        "For College: Degree program (e.g., 'BS Information Technology', 'Bachelor of Science in Accountancy'). For High School / Senior High: The Track & Strand / Specialization (e.g. 'Academic Track - Accountancy, Business and Management (ABM)', 'STEM', 'TVL-ICT', 'HUMSS', 'GAS').",
    },
    track: {
      type: 'string',
      description:
        "For Senior High (Form 138 / SF9): The Track if specified (e.g., 'Academic Track', 'Technical-Vocational-Livelihood (TVL) Track', 'Arts and Design'). Null if not high school.",
    },
    strand: {
      type: 'string',
      description:
        "For Senior High (Form 138 / SF9): The specific Strand name (e.g., 'ABM', 'Accountancy, Business and Management', 'STEM', 'HUMSS', 'GAS', 'ICT'). Null if not high school.",
    },
    grade_level: {
      type: 'string',
      description:
        "Grade or Year level. For Form 138 / Form 9, check the 'Grade' or 'Grade / Section' field (e.g., if 'Grade: 11' or '11 - ABM', extract 'Grade 11' or '11'). For college, extract '1st Year', '2nd Year', etc.",
    },
    section: {
      type: 'string',
      description:
        "Class section identifier. For Form 138 / Form 9, check the 'Section' or 'Grade & Section' field (e.g., '11-ABM', '12-STEM 1', '7-Diamond', 'ABM-A'). Extract the clean section code (e.g., '11-ABM' or 'ABM'), NOT the full school or program name.",
    },
    has_signature: {
      type: 'boolean',
      description:
        'True if a registrar signature, authorized signature line, or official school seal/stamp is visible; otherwise false.',
    },
    general_average: {
      type: 'number',
      description:
        "The overall 'General Average' or 'GWA' printed at the bottom of the document or grade table. Null if unavailable.",
    },
    academic_year: {
      type: 'string',
      description:
        'School year / Academic year (e.g., "2024-2025"). Remove prefixes like "A.Y.", "AY", "S.Y.", "SY".',
    },
    semester: {
      type: 'string',
      description:
        'Main semester/cycle (e.g., "1st Semester", "2nd Semester", "Summer", "1st Trimester"). Return "Annual" for high school Form 138 unless explicitly separated.',
    },
    term: {
      type: 'string',
      description:
        'Specific sub-term or period within semester if stated (e.g., "1st Term", "2nd Term"). Default to "Full Semester" if not specified.',
    },
    first_sem_average: {
      type: 'number',
      description:
        'General average for First Semester at footer of 1st Semester table.',
    },
    second_sem_average: {
      type: 'number',
      description:
        'General average for Second Semester at footer of 2nd Semester table.',
    },
    grades: {
      type: 'array',
      description:
        'List of all individual academic subjects and their final grades extracted from the document.',
      items: {
        type: 'object',
        properties: {
          subject_code: {
            type: 'string',
            description:
              'Course code or subject identifier (e.g., "COR 1", "APP 1", "ABM 1", "NSTP 1", "GE 2"). If the code and title are printed together in one cell (e.g. "COR 1 Oral Communication"), extract the prefix as subject_code.',
          },
          subject_name: {
            type: 'string',
            description:
              'Descriptive title of the subject (e.g., "Oral Communication", "General Mathematics", "Organization and Management"). REQUIRED for every grade item. NEVER leave blank or null.',
          },
          units: {
            type: 'number',
            description:
              'Credit units. For college documents, extract listed units. For high school Form 138 / SF9, default to 1.0 if not listed.',
          },
          grade: {
            type: 'number',
            description:
              'Final numerical grade earned. For DepEd Form 138 / SF9 / Form 9 report cards, extract the value in the "Final Grade" / "Semestral Final Grade" / "FG" column. Do NOT extract quarter grades (1, 2, 3, 4).',
          },
          semester: {
            type: 'string',
            description:
              '"1st Semester" or "2nd Semester" based on table section.',
          },
        },
        required: ['subject_name', 'grade'],
      },
    },
    grading_legend: {
      type: 'object',
      description:
        'Grading system / evaluation legend printed on the document (often found on the reverse side or footer of Transcript of Records / Grade Report). Null if no legend is found.',
      properties: {
        legend_title: {
          type: 'string',
          description:
            'Header or title of the applicable grading legend (e.g., "GRADING SYSTEM & EQUIVALENT EFFECTIVE 1ST SEMESTER SY 2020-2021 (FOR UNDERGRADUATE)").',
        },
        grading_scale: {
          type: 'string',
          enum: [
            'NUMERIC_5_POINT',
            'NUMERIC_4_POINT',
            'PERCENTAGE_100',
            'OTHER',
          ],
          description:
            '"NUMERIC_4_POINT" if 4.0 is highest and 1.0 or 2.0 is lowest/passing (e.g. UM: 4.00 Excellent/100%, 2.00 Passing/75%, 1.00 Failure/50%); "NUMERIC_5_POINT" if 1.0 is highest and 3.0 is passing, 5.0 is failing (e.g. USEP, UP, ADDU); "PERCENTAGE_100" if 75-100% scale (e.g. DepEd Form 138).',
        },
        highest_grade: {
          type: 'number',
          description:
            'Top/highest numerical mark (e.g., 1.00 for 5-point scale, 4.00 for 4-point scale, 100.00 for percentage).',
        },
        passing_grade: {
          type: 'number',
          description:
            'Minimum passing mark (e.g., 3.00 for 5-point scale, 2.00 for 4-point scale, 75.00 for percentage).',
        },
        failing_grade: {
          type: 'number',
          description:
            'Failing mark (e.g., 5.00 for 5-point scale, 1.00 for 4-point scale, 50.00 for percentage).',
        },
        special_codes: {
          type: 'object',
          description:
            'Key-value pairs of special codes or non-numeric marks listed in the legend (e.g., {"7.1": "LACKING_PAYMENT", "7.2": "LACKING_REQUIREMENTS", "9.0": "DROPPED", "INC": "INCOMPLETE", "PSD": "PASSED"}).',
        },
        notes: {
          type: 'string',
          description:
            'Any notable remarks, percentage equivalents, or policies extracted from the legend.',
        },
      },
    },
  },
  required: ['student_name', 'grades'],
};

const PROSPECTUS_DATA_SCHEMA = {
  type: 'object',
  properties: {
    course_name: {
      type: 'string',
      description:
        'Full program or degree name (e.g., "Bachelor of Science in Information Technology", "BS Computer Science").',
    },
    course_code: {
      type: 'string',
      description:
        'Course code or program abbreviation (e.g., "BSIT", "BSCS", "BSIS").',
    },
    curriculum_year: {
      type: 'string',
      description:
        'Effective curriculum school year (e.g., "2023-2024", "2024-2025", "Effective SY 2021-2022").',
    },
    total_units: {
      type: 'number',
      description: 'Total credit units required across all years.',
    },
    subjects: {
      type: 'array',
      description:
        'All curriculum subjects organized across all year levels and semesters.',
      items: {
        type: 'object',
        properties: {
          subject_code: {
            type: 'string',
            description:
              'Course / subject code (e.g., "IT 101", "CCE 102", "GE 2", "NSTP 1").',
          },
          descriptive_title: {
            type: 'string',
            description:
              'Descriptive title of the subject (e.g., "Introduction to Computing").',
          },
          units: {
            type: 'number',
            description:
              'Credit units (e.g. 3.0). If lecture and laboratory are listed separately, sum them.',
          },
          year_level: {
            type: 'number',
            description:
              'Numeric year level (1 for 1st Year, 2 for 2nd Year, 3 for 3rd Year, 4 for 4th Year).',
          },
          semester: {
            type: 'string',
            description:
              'Term/semester ("1st Semester", "2nd Semester", or "Summer").',
          },
          grade: {
            type: 'string',
            description:
              'Grade mark or rating obtained if the subject is completed/taken on this evaluation sheet (e.g. "4.0", "3.5", "3.0", "2.5", "2.0", "1.0", "PSD", "PASSED", "7.1", "9.0", "INC"). Set to null if untaken/no grade.',
          },
          status: {
            type: 'string',
            description:
              'Course completion status on the evaluation sheet (e.g. "PASSED", "CREDITED", "ENROLLED", "FAILED", "UNTAKEN"). If grade is passing (e.g. 2.0-4.0 in UM or 1.0-3.0 in UP/USEP or PSD), set to "PASSED" or "CREDITED".',
          },
          credited_term: {
            type: 'string',
            description:
              'Academic year / semester or term label when this course was taken (e.g., "1st Year - 1st Sem", "2023-2024 1st Sem", or null).',
          },
          prerequisites: {
            type: 'array',
            items: { type: 'string' },
            description:
              'List of prerequisite subject codes (e.g. ["CCE 101"]). Empty array if none.',
          },
        },
        required: [
          'subject_code',
          'descriptive_title',
          'units',
          'year_level',
          'semester',
        ],
      },
    },
  },
  required: ['subjects'],
};

@Injectable()
export class LlamaExtractService implements IDocumentExtractor {
  private readonly logger = new Logger(LlamaExtractService.name);

  // In-memory SHA-256 deduplication cache with TTL
  private readonly extractionCache = new Map<
    string,
    { result: unknown; cachedAt: number }
  >();
  private readonly MAX_CACHE_ENTRIES = 200;
  private readonly CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(private configService: ConfigService) {}

  /**
   * Generates a deterministic SHA-256 cache key from file buffer, data schema, and prompt.
   * Guarantees that identical documents under identical extraction targets hit the cache,
   * while different schemas or modified files yield completely unique keys.
   */
  private computeCacheKey(
    buffer: Buffer,
    schema: Record<string, any>,
    systemPrompt?: string,
  ): string {
    const hash = createHash('sha256');
    hash.update(buffer);
    hash.update('::');
    hash.update(JSON.stringify(schema));
    if (systemPrompt) {
      hash.update('::');
      hash.update(systemPrompt);
    }
    return hash.digest('hex');
  }

  /**
   * Retrieves a cached extraction result. Returns a pristine structuredClone
   * so downstream modifications never mutate the cached payload.
   */
  private getCachedResult<T>(key: string): T | null {
    const entry = this.extractionCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.CACHE_TTL_MS) {
      this.extractionCache.delete(key);
      return null;
    }
    return structuredClone(entry.result) as T;
  }

  /**
   * Stores a successful extraction in the cache, evicting the oldest entry if full.
   */
  private setCachedResult<T>(key: string, result: T): void {
    if (this.extractionCache.size >= this.MAX_CACHE_ENTRIES) {
      const oldestKey = this.extractionCache.keys().next().value;
      if (oldestKey) {
        this.extractionCache.delete(oldestKey);
      }
    }
    this.extractionCache.set(key, {
      result: structuredClone(result),
      cachedAt: Date.now(),
    });
  }

  private getClient(): LlamaCloud {
    const apiKey =
      this.configService.get<string>('LLAMA_CLOUD_API_KEY') ||
      this.configService.get<string>('LLAMA_PARSE_API_KEY') ||
      process.env.LLAMA_CLOUD_API_KEY;

    if (!apiKey) {
      throw new Error(
        'LLAMA_CLOUD_API_KEY is not configured in environment variables.',
      );
    }

    return new LlamaCloud({ apiKey });
  }

  /**
   * Helper that merges multiple input files (images or PDFs) into a single multi-page PDF buffer.
   */
  private async mergeInputFilesToSinglePdf(
    files: InputDocumentFile[],
  ): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
    if (files.length === 1) {
      return {
        buffer: files[0].buffer,
        fileName: files[0].fileName || 'document.pdf',
        mimeType: files[0].mimeType || 'application/pdf',
      };
    }

    this.logger.log(
      `Merging ${files.length} input files into a single multi-page PDF before dispatching to LlamaExtract...`,
    );

    const mergedPdf = await PDFDocument.create();

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const mime = (f.mimeType || '').toLowerCase();
      const name = (f.fileName || '').toLowerCase();
      const isPdf = mime.includes('pdf') || name.endsWith('.pdf');

      try {
        if (isPdf) {
          const srcDoc = await PDFDocument.load(f.buffer, {
            ignoreEncryption: true,
          });
          const copiedPages = await mergedPdf.copyPages(
            srcDoc,
            srcDoc.getPageIndices(),
          );
          copiedPages.forEach((p) => mergedPdf.addPage(p));
        } else if (mime.includes('png') || name.endsWith('.png')) {
          const img = await mergedPdf.embedPng(f.buffer);
          const page = mergedPdf.addPage([img.width, img.height]);
          page.drawImage(img, {
            x: 0,
            y: 0,
            width: img.width,
            height: img.height,
          });
        } else {
          // JPEG / WebP / generic image fallback
          try {
            const img = await mergedPdf.embedJpg(f.buffer);
            const page = mergedPdf.addPage([img.width, img.height]);
            page.drawImage(img, {
              x: 0,
              y: 0,
              width: img.width,
              height: img.height,
            });
          } catch {
            const img = await mergedPdf.embedPng(f.buffer);
            const page = mergedPdf.addPage([img.width, img.height]);
            page.drawImage(img, {
              x: 0,
              y: 0,
              width: img.width,
              height: img.height,
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `Could not embed file index ${i} ('${f.fileName}') into PDF: ${err.message}`,
        );
      }
    }

    if (mergedPdf.getPageCount() === 0) {
      // Fallback to first file if merging didn't add pages
      return {
        buffer: files[0].buffer,
        fileName: files[0].fileName || 'document.pdf',
        mimeType: files[0].mimeType || 'application/pdf',
      };
    }

    const mergedBytes = await mergedPdf.save();
    const primaryName =
      files[0].fileName?.replace(/\.[^/.]+$/, '') || 'document';

    return {
      buffer: Buffer.from(mergedBytes),
      fileName: `${primaryName}_merged_${files.length}pages.pdf`,
      mimeType: 'application/pdf',
    };
  }

  private async executeExtraction<T>(
    input: InputDocumentFile | InputDocumentFile[],
    dataSchema: Record<string, any>,
    systemPrompt?: string,
  ): Promise<T> {
    const client = this.getClient();
    const files = Array.isArray(input) ? input : [input];

    if (files.length === 0 || !files[0]?.buffer) {
      throw new Error('No valid file buffer provided for LlamaExtract.');
    }

    // Merge all files/pages into a single unified document so LlamaExtract processes ALL pages
    const unifiedFile = await this.mergeInputFilesToSinglePdf(files);
    const fileName = unifiedFile.fileName;
    const mimeType = unifiedFile.mimeType;

    // Check SHA-256 deduplication cache
    const cacheKey = this.computeCacheKey(
      unifiedFile.buffer,
      dataSchema,
      systemPrompt,
    );
    const cachedResult = this.getCachedResult<T>(cacheKey);
    if (cachedResult) {
      this.logger.log(
        `[SHA-256 Cache Hit] Reusing verified extraction for '${fileName}' (hash: ${cacheKey.slice(0, 10)}). Instant return (<50ms).`,
      );
      return cachedResult;
    }

    this.logger.log(
      `Uploading unified document '${fileName}' (${mimeType}, from ${files.length} source file(s)) to LlamaCloud for extraction...`,
    );

    const uploadable = await toFile(unifiedFile.buffer, fileName, {
      type: mimeType,
    });

    const fileObj = await client.files.create({
      file: uploadable,
      purpose: 'extract',
      external_file_id: fileName,
    });

    this.logger.log(
      `Created LlamaCloud file ${fileObj.id}. Initiating extraction job...`,
    );

    const job = await client.extract.create({
      file_input: fileObj.id,
      configuration: {
        data_schema: dataSchema as any,
        extraction_target: 'per_doc',
        tier: 'agentic',
        ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      },
    });

    this.logger.log(
      `LlamaExtract job ${job.id} dispatched. Waiting for completion...`,
    );

    let currentJob = job;
    let attempts = 0;
    let elapsedMs = 0;
    const maxWaitMs = 600000; // 10 minutes (600 seconds)

    // Adaptive polling: checks faster early on (1200ms -> 1800ms -> 2500ms)
    // to capture completed extractions without unnecessary idle wait.
    const getAdaptivePollIntervalMs = (attemptCount: number): number => {
      if (attemptCount < 5) return 1200;
      if (attemptCount < 15) return 1800;
      return 2500;
    };

    while (
      !['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentJob.status) &&
      elapsedMs < maxWaitMs
    ) {
      const interval = getAdaptivePollIntervalMs(attempts);
      await new Promise((resolve) => setTimeout(resolve, interval));
      elapsedMs += interval;
      currentJob = await client.extract.get(job.id);
      attempts++;

      if (attempts % 10 === 0) {
        this.logger.log(
          `LlamaExtract job ${job.id} still in progress (status: ${currentJob.status}, ${Math.round(elapsedMs / 1000)}s elapsed)...`,
        );
      }
    }

    if (currentJob.status !== 'COMPLETED') {
      const isTimeout =
        currentJob.status === 'RUNNING' || currentJob.status === 'PENDING';
      const errorMsg = isTimeout
        ? `LlamaExtract job ${job.id} timed out after ${Math.round(elapsedMs / 1000)}s while still processing on LlamaCloud.`
        : currentJob.error_message ||
          `LlamaExtract job ${job.id} ended with status ${currentJob.status}`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const result = currentJob.extract_result;
    if (!result) {
      throw new Error(
        `LlamaExtract job ${job.id} completed without extract_result.`,
      );
    }

    // Save successful extraction to SHA-256 deduplication cache
    if (result && typeof result === 'object' && Object.keys(result).length > 0) {
      this.setCachedResult(cacheKey, result);
    }

    // Clean up remote uploaded file if possible
    try {
      await client.files.delete(fileObj.id);
    } catch (cleanupErr: any) {
      this.logger.debug(
        `File cleanup skipped for ${fileObj.id}: ${cleanupErr.message}`,
      );
    }

    return result as T;
  }

  async extractData(
    input: InputDocumentFile | InputDocumentFile[],
    documentType: string,
  ): Promise<ExtractedResult> {
    const systemPrompt = `You are an expert document OCR and structured data extraction AI specializing in Philippine academic documents (Form 138 / Report Card / SF9, Transcript of Records - TOR, Statement of Account, Certified Copy of Grades - COG).
Your task is to analyze the attached document and extract structured JSON adhering strictly to the schema for document type: ${documentType}.

STRICT EXTRACTION INSTRUCTIONS:
1. Document Type Detection ('detected_document_type'):
   - Check the top-left, top-center header, or document titles:
     * "SF9", "SF9-SHS", "SF9-JHS", "Form 138", "Form 9", "Form 137", "Progress Report Card", "Learner's Progress Report Card", "DepEd" -> "FORM_138"
     * "Official Transcript of Records", "Transcript of Records", "TOR", "Permanent Record" -> "TRANSCRIPT_OF_RECORDS"
     * "Certified Copy of Grades", "Certificate of Grades", "COG", "CCG", "Grade Slip", "Report of Rating", "Semester Grades", "Semestral Grade Report" -> "CERTIFICATE_OF_GRADES"
     * "Statement of Account", "Assessment Form", "Tuition Assessment", "Student Ledger", "Billing" -> "STATEMENT_OF_ACCOUNT"
     * "Certificate of Registration", "Certificate of Matriculation", "COR", "COM", "Registration Form", "Class Schedule" -> "CERTIFICATE_OF_REGISTRATION"
     * Other documents -> "OTHER"
2. Senior High / Junior High (Form 138 / Form 9 / SF9):
   - Check header metadata fields for Grade, Section, Track, and Strand:
     * "Grade / Section" or "Grade:" and "Section:" (e.g. if header says '11 - ABM 1' or 'Grade 11 - ABM', extract grade_level: 'Grade 11', section: '11-ABM 1' or 'ABM 1')
     * "Track:" (e.g. 'Academic Track', 'TVL Track') -> extract to 'track'
     * "Strand:" (e.g. 'Accountancy, Business and Management (ABM)', 'STEM', 'HUMSS') -> extract to 'strand' and 'course_name'
     * Do NOT extract descriptive tracks as the section name. The section is the short code/name (e.g. '11-ABM', 'Diamond', '12-STEM 1').
   - REPORT ON LEARNING PROGRESS AND ACHIEVEMENT (Grades Table):
     * DepEd SF9 / Form 138 report cards organize subjects into TWO distinct semestral tables: 'FIRST SEMESTER' and 'SECOND SEMESTER'.
     * The columns are: [SUBJECTS | 1 | 2 | FG] for 1st Semester (Quarter 1, Quarter 2, Final Grade 'FG') and [SUBJECTS | 3 | 4 | FG] for 2nd Semester (Quarter 3, Quarter 4, Final Grade 'FG').
     * ALWAYS extract the value in the 'FG' (Final Grade) column as the 'grade'. Do NOT extract quarterly ratings (columns 1, 2, 3, 4).
     * STRICT ROW BINDING & ALIGNMENT: Each horizontal row corresponds to EXACTLY ONE subject. Do NOT let document paper curvature, camera tilt, or vertical perspective skew cause a row offset. Trace each row horizontally across the grid from the subject name to its corresponding FG grade.
     * Row 1 in 1st Semester is 'COR 1 Oral Communication' with FG 93. Do NOT detach 93 into a phantom row!
     * ALL subjects in the semester must be extracted, including all Core ('COR'), Applied ('APP'), and Specialized ('ABM' / 'STEM' / 'HUMSS') subjects. For example, in 1st Semester, extract all 8 subjects down to 'ABM 1 Organization and Management' (FG: 89).
     * Separate Subject Code and Title: If the cell contains both (e.g. 'COR 1 Oral Communication'), extract subject_code: 'COR 1' and subject_name: 'Oral Communication'. If 'ABM 1 Organization and Management', extract subject_code: 'ABM 1' and subject_name: 'Organization and Management'.
     * NO PHANTOM ENTRIES: Every grade item MUST have a valid, non-empty subject_name. Never extract a row without a subject name. Never extract table section headers or semester averages as subjects.
3. College Documents (TOR / COG):
   - Extract Degree Program (e.g. 'Bachelor of Science in Information Technology', 'BS Accountancy') into 'course_name'.
   - Extract Year Level (e.g. '1st Year', '2nd Year', '3rd Year') into 'grade_level'.
   - MULTI-SEMESTER CHRONOLOGICAL STRUCTURE:
     * Transcripts organize courses by Academic Year and Semester blocks (e.g., "FIRST SEMESTER AY 2021-2022", "SECOND SEMESTER 2021-2022", "SUMMER 2022", "FIRST SEMESTER 2022-2023").
     * Assign the corresponding 'semester' label (e.g. "1st Semester", "2nd Semester", "Summer") to every subject within that block.
   - PARALLEL / TWO-COLUMN PAGE LAYOUTS:
     * Many Philippine university TORs (e.g., University of Mindanao, UP, ADDU, USEP, UIC, HCDC) print semesters in TWO parallel vertical columns on each page (e.g., Year 1 on the left side, Year 2 on the right side).
     * Process each semester block vertically from top to bottom. NEVER read across horizontally between parallel columns, as that scrambles course codes from different years.
   - DISAMBIGUATION OF UNITS VS GRADES:
     * College transcript tables typically feature columns: [Course No. | Descriptive Title | Final Rating/Grade | Units/Credits].
     * Carefully distinguish 'units' (usually small integer or half-integer numbers like 3.0, 2.0, 1.0, 4.0, 5.0) from 'grade' (e.g. 1.00, 1.25, 1.50, 1.75, 2.00, 2.50, 3.00, 3.50, 4.00, or 75–100).
     * NEVER swap or invert units with grades.
     * If Lecture ('Lec') and Laboratory ('Lab') units are listed separately (e.g., Lec: 2, Lab: 1), sum them into total credit units (3.0).
   - EXCLUDE ADMINISTRATIVE HEADERS, LABELS, AND FOOTERS:
     * Do NOT extract administrative or structural lines as subjects. Ignore:
       - Term headings: "FIRST SEMESTER AY 2022-2023", "MIDYEAR TERM 2023", "SECOND TRIMESTER"
       - Admission lines: "ACADEMIC ENTRANCE: HIGH SCHOOL GRADUATE", "CREDITED FROM PREVIOUS COLLEGE", "ENTRANCE CREDENTIALS"
       - Column headings: "COURSE NO.", "DESCRIPTIVE TITLE", "FINAL RATING", "CREDITS", "REMARKS"
       - Subtotals & footers: "TOTAL UNITS EARNED: 21.0", "TERM GPA: 1.65", "CUMULATIVE GPA: 1.72", "SEMESTRAL AVERAGE", "*** NOTHING FOLLOWS ***"
   - MULTI-PAGE COMPLETENESS:
     * College TORs span 2 to 4+ pages. Extract all completed curriculum courses across ALL pages of the merged document.
4. Grading Legend & Scale Disambiguation ('grading_legend'):
   - Many Philippine college transcripts (TOR) display multiple grading system tables/legends (e.g. for Undergraduate vs. Juris Doctor / Professional School vs. Old/Legacy systems).
   - ALWAYS select the legend applicable to UNDERGRADUATE / COLLEGE students. Ignore legends labeled "JURIS DOCTOR", "PROFESSIONAL SCHOOL", "GRADUATE SCHOOL", or "MASTER'S/DOCTORAL".
   - Match the document's academic year / semester against the legend's "EFFECTIVE" dates. For current and recent college records (e.g., 2021-2026), prioritize current undergraduate scales (e.g., "EFFECTIVE 1ST SEMESTER SY 2020-2021 (FOR UNDERGRADUATE)") over legacy scales (e.g., "EFFECTIVE SUMMER 2020-BELOW").
   - Cross-verify the extracted subject numerical grades against the scale direction:
     * If subject grades are numbers like 3.5, 3.2, 4.0, 2.5, 2.0, the scale is NUMERIC_4_POINT (UM scale: 4.00 is highest, 2.00 is passing, 1.00 is failing).
     * If subject grades are numbers like 1.25, 1.50, 1.75, 2.00, 2.50, 3.00, the scale is NUMERIC_5_POINT (USEP/UP/ADDU scale: 1.00 is highest, 3.00 is passing, 5.00 is failing).
     * If subject grades are numbers like 85, 90, 92, the scale is PERCENTAGE_100 (DepEd scale: 100 is highest, 75 is passing).
   - Extract special status codes listed in the legend (e.g., {"7.1": "LACKING_PAYMENT", "7.2": "LACKING_REQUIREMENTS", "9.0": "DROPPED", "INC": "INCOMPLETE", "PSD": "PASSED", "DRP": "DROPPED", "TWE": "TOTAL_WITHDRAWAL"}) into 'special_codes'.
5. Official Signature & Certification Seal ('has_signature'):
   - Look carefully for official signatures, digital registrar signatures, dean/principal signatures, registrar stamp impressions, "CERTIFIED TRUE COPY" stamps, or university dry seals.
   - Return true if any authorized signature, stamp, or seal is visible on the document.
   - Return false if the document has NO signature, NO stamp, and NO seal (e.g. an uncertified portal screenshot, self-service web printout without signature, or draft).
6. Format:
   - Ensure numeric values for grades, units, and averages are numbers (e.g. 1.75, 88.5, 90.0), not stringified numbers.
   - If a field is not found or not applicable, set it to null.`;

    const rawData = await this.executeExtraction<ExtractedResult>(
      input,
      DOCUMENT_DATA_SCHEMA,
      systemPrompt,
    );

    return {
      detected_document_type: rawData.detected_document_type,
      student_name: rawData.student_name,
      school_name: rawData.school_name,
      course_name: rawData.course_name,
      track: rawData.track,
      strand: rawData.strand,
      grade_level: rawData.grade_level,
      section: rawData.section,
      has_signature: rawData.has_signature,
      general_average: rawData.general_average,
      academic_year: rawData.academic_year,
      semester: rawData.semester,
      term: rawData.term,
      first_sem_average: rawData.first_sem_average,
      second_sem_average: rawData.second_sem_average,
      grades: (Array.isArray(rawData.grades) ? rawData.grades : [])
        .filter((g: any) => {
          const rawName = String(g.subject_name || '').trim();
          const rawCode = String(g.subject_code || '').trim();
          const hasName = rawName.length > 0;
          const hasCode = rawCode.length > 0;

          // Reject structural noise or summary lines that might be misread as subjects
          const isStructuralNoise =
            /^(total\s*units|cumulative|semestral|term\s*gpa|nothing\s*follows|entrance\s*credentials|academic\s*entrance)/i.test(
              rawName || rawCode,
            );

          return (hasName || hasCode) && g.grade != null && !isStructuralNoise;
        })
        .map((g: any) => {
          let code = String(g.subject_code || '').trim();
          let name = String(g.subject_name || '').trim();

          if (!code && name) {
            const match = name.match(/^([A-Z0-9_-]+\s*\d+[a-z]?)\s+(.*)$/i);
            if (match) {
              code = match[1].trim();
              name = match[2].trim();
            }
          }

          if (!name && code) {
            const match = code.match(/^([A-Z0-9_-]+\s*\d+[a-z]?)\s+(.*)$/i);
            if (match) {
              code = match[1].trim();
              name = match[2].trim();
            } else {
              name = code;
            }
          }

          const rawUnits = Number(g.units);
          const units =
            !isNaN(rawUnits) && rawUnits > 0
              ? rawUnits
              : rawData.detected_document_type === 'FORM_138'
                ? 1.0
                : 3.0;

          return {
            ...g,
            subject_code: code,
            subject_name: name,
            units,
            grade: Number(g.grade),
          };
        }),
      grading_legend: rawData.grading_legend ?? null,
    };
  }

  async extractProspectusData(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<{
    course_name?: string;
    course_code?: string;
    curriculum_year?: string;
    total_units?: number;
    subjects: Array<{
      subject_code: string;
      descriptive_title: string;
      units: number;
      year_level: number;
      semester: string;
      grade?: string | null;
      status?: string | null;
      credited_term?: string | null;
      prerequisites?: string[];
    }>;
  }> {
    const systemPrompt = `You are an expert academic curriculum OCR and structured extraction AI specializing in Philippine college and university curriculum evaluation sheets, program checklists, and prospectuses.

CRITICAL INSTRUCTIONS:
1. Extract all curriculum subjects organized by Year Level (1, 2, 3, 4) and Semester ("1st Semester", "2nd Semester", "Summer").
2. Pay special attention to section headers indicating Year & Semester (e.g. "1st Year / 1st Sem", "1st Year 2nd Sem", "2nd Year / 1st Sem", "3rd Year", "4th Year"). Every subject MUST be assigned its exact year_level (1, 2, 3, 4) and semester ("1st Semester", "2nd Semester", etc.).
3. For Student Portal Evaluation screenshots or Academic Program Evaluations:
   - Rows often display the grade mark before or after the subject code (e.g. "4.0 CCE 102 3.0 Computer Programming 1", "4.0 PAHF 1 2.0 MOVEMENT COMPETENCY TRAINING", "3.5 IT 101 3.0 Introduction to Computing", or "PSD NSTP 1 3.0 CWTS").
   - If a grade is present on the row, extract it into the 'grade' field (e.g., "4.0", "3.5", "PSD", "2.0").
   - Set 'status' to "PASSED" or "CREDITED" if a passing grade is present, "FAILED" if failing, or "UNTAKEN" if blank/no grade.
   - Set 'credited_term' to the term label (e.g. "1st Year - 1st Sem") if applicable.
4. Extract credit units as numbers (e.g. 3.0, 2.0, 1.0).
5. Output clean subject codes (e.g., "CCE 102", "PAHF 1", "IT 101").`;

    const rawData = await this.executeExtraction<any>(
      input,
      PROSPECTUS_DATA_SCHEMA,
      systemPrompt,
    );

    return {
      course_name: rawData.course_name,
      course_code: rawData.course_code,
      curriculum_year: rawData.curriculum_year,
      total_units: rawData.total_units,
      subjects: Array.isArray(rawData.subjects) ? rawData.subjects : [],
    };
  }

  async extractEnrollmentCorData(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<any> {
    const systemPrompt = `You are an expert academic document OCR AI specializing in Philippine college and university Certificate of Registration (COR), Certificate of Matriculation (COM), Class Schedules, Study Load, and Form 1.

CRITICAL DOCUMENT TYPE CLASSIFICATION:
1. Classify the document under detected_document_type:
   - 'CERTIFICATE_OF_REGISTRATION': A valid Certificate of Registration, Class Schedule, or Study Load listing academic courses/subjects (e.g., IT 101, ENG 1, MATH 2) and units.
   - 'STATEMENT_OF_ACCOUNT': A Statement of Account, Tuition Fee Assessment, Student Ledger, or Billing statement showing fees (Tuition, Miscellaneous, Lab, Balance Due) WITHOUT a class schedule.
   - 'CONSOLIDATED_ENROLLMENT': Contains both an enrolled class schedule and a financial tuition fee assessment on the same document.
   - 'OTHER': Unrelated document (ID card, grade report, receipt, etc.).
2. Set is_class_schedule to true ONLY if the document explicitly contains registered/enrolled subjects or course schedule table.
3. Set is_assessment_form to true if the document is primarily an assessment of fees or statement of account.
4. DO NOT treat tuition fee lines, miscellaneous fees, or payment breakdowns as academic subjects! Only parse actual course offerings/subjects (e.g. Computer Programming, Data Structures, English, Calculus).`;

    const rawData = await this.executeExtraction<any>(
      input,
      ENROLLMENT_COR_DATA_SCHEMA,
      systemPrompt,
    );
    return rawData;
  }

  async extractEnrollmentSoaData(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<any> {
    const systemPrompt = `You are an expert financial document OCR AI specializing in Philippine college and university Statement of Account (SOA), Student Ledgers, Tuition Fee Assessment Forms, and Billing Statements.

CRITICAL DOCUMENT TYPE CLASSIFICATION:
1. Classify the document under detected_document_type:
   - 'STATEMENT_OF_ACCOUNT': A valid Statement of Account, Tuition Fee Assessment, Student Ledger, or Billing statement showing fees and charges (e.g., Tuition Fee, Miscellaneous, Laboratory, Total Assessment, Balance Due).
   - 'CERTIFICATE_OF_REGISTRATION': A Certificate of Registration, Class Schedule, or Study Load listing enrolled subjects WITHOUT a financial tuition billing assessment.
   - 'CONSOLIDATED_ENROLLMENT': Contains both an enrolled class schedule and a financial tuition fee assessment on the same document.
   - 'OTHER': Unrelated document (ID card, grade card, receipt, etc.).
2. Set is_assessment_form to true ONLY if the document explicitly contains tuition fees, assessment breakdown, or balance due.
3. Set is_class_schedule to true if the document is primarily a class schedule.
4. If the document is purely a class schedule with no tuition fees or balance due, classify it as 'CERTIFICATE_OF_REGISTRATION' and set is_assessment_form to false.`;

    const rawData = await this.executeExtraction<any>(
      input,
      ENROLLMENT_SOA_DATA_SCHEMA,
      systemPrompt,
    );
    return rawData;
  }

  async extractConsolidatedEnrollmentData(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<any> {
    const systemPrompt = `You are an expert academic and financial document OCR AI specializing in consolidated Philippine university enrollment & assessment forms (e.g. UM Certificate of Matriculation, HCDC Registration/Assessment Form).
Extract the student identification, semester, enrolled subjects table, and financial tuition assessment breakdown. Set detected_document_type to 'CONSOLIDATED_ENROLLMENT'.`;

    const rawData = await this.executeExtraction<any>(
      input,
      CONSOLIDATED_ENROLLMENT_DATA_SCHEMA,
      systemPrompt,
    );
    return rawData;
  }

  async extractOfficialReceiptData(
    input: InputDocumentFile | InputDocumentFile[],
  ): Promise<ExtractedReceiptData> {
    const systemPrompt = `You are an expert OCR and structured data extraction AI specializing in Philippine university cashier Official Receipts (OR).
IMPORTANT EXTRACTION GUIDELINES:
1. Philippine university receipts (e.g. from University of Mindanao / UM, Ateneo, UIC, USEP, HCDC) are frequently printed on continuous pre-printed dot-matrix forms or thermal paper slips.
2. Text and numbers may be printed out of place, misaligned with pre-printed form boxes, or overlapping cashier stamps ("PAID", date stamps, cashier signature).
3. The Official Receipt Number (OR #) is frequently composite, hyphenated, or alphanumeric with trailing letters (e.g. '46127-004084B', '109284-B', '0048192'). Extract the complete, exact alphanumeric string. CRITICAL: Do NOT confuse the pre-printed booklet/serial number (e.g. '3236889' printed in red at the top right) with the university cashier's electronic OR number (e.g. '46127-004084B'). Always prioritize the cashier-printed or portal-recorded alphanumeric transaction code (often formatted as StudentID-SequenceSeries like '46127-004084B' or 'OR-102948') over any pre-printed booklet sequence number.
4. Extract the Student ID Number (e.g. '46127' or '2021-00123'), full Student/Payor Name, total numeric Amount Paid (PHP), cashier transaction date (YYYY-MM-DD), issuing University Name, and Payment Mode (e.g., 'CHECK', 'CASH').`;

    const rawData = await this.executeExtraction<ExtractedReceiptData>(
      input,
      OFFICIAL_RECEIPT_DATA_SCHEMA,
      systemPrompt,
    );
    return rawData;
  }
}
