export const OFFICIAL_RECEIPT_DATA_SCHEMA = {
  type: 'object',
  properties: {
    or_number: {
      type: 'string',
      description:
        "Official Receipt (OR) Number printed on the receipt. In Philippine universities (e.g. University of Mindanao / UM, Ateneo, UIC, USEP), this can be composite, hyphenated, or alphanumeric with trailing letters (e.g. '46127-004084B', 'OR-102948', '0048192', '46127004084B'). Look for labels like 'O.R. NO.', 'OR #', 'OFFICIAL RECEIPT NO.', or printed serial numbers at the top right, header, or footer.",
    },
    student_id: {
      type: 'string',
      description:
        "Student ID / Student Number / Account Number printed on the receipt (e.g. '46127', '2021-00123', '612849'). May appear as prefix before hyphens or next to 'STUDENT ID', 'STUDENT NO.', 'ID NO.', 'ACCT NO.'.",
    },
    student_name: {
      type: 'string',
      description:
        "Student or Payor full name printed on the receipt (e.g. 'DELA CRUZ, JUAN A.', 'JUAN DELA CRUZ'). Look for 'RECEIVED FROM', 'STUDENT NAME', 'PAYOR', or 'NAME'.",
    },
    amount_paid: {
      type: 'number',
      description:
        "Total payment amount or net amount paid as a pure numeric value in PHP (e.g. 18500.00). Look for 'AMOUNT PAID', 'TOTAL AMOUNT', 'NET AMOUNT', 'AMOUNT RECEIVED', or Philippine Peso currency values (₱ or PHP). Strip currency symbols and commas.",
    },
    payment_date: {
      type: 'string',
      description:
        "Date of cashier transaction formatted as YYYY-MM-DD (e.g. '2026-09-18'). Look for 'DATE', 'TRANSACTION DATE', or date stamps printed by the university cashier.",
    },
    school_name: {
      type: 'string',
      description:
        "Name of the issuing university or educational institution (e.g., 'University of Mindanao', 'The University of Mindanao, Inc.', 'Ateneo de Davao University'). Look for headers, logos, or institutional letterhead.",
    },
    payment_mode: {
      type: 'string',
      description:
        "Method of payment recorded by cashier (e.g. 'CHECK', 'CHECK #...', 'CASH', 'ONLINE / BANK DEPOSIT').",
    },
    check_number_reference: {
      type: 'string',
      description:
        "Check serial number referenced on the receipt if noted by cashier (e.g., '902148' or 'Check #902148').",
    },
    remarks: {
      type: 'string',
      description:
        "Any additional details, cashier window number, term/semester reference (e.g. '1st Sem 2026-2027 Tuition Fee', 'Cashier Window 4').",
    },
  },
  required: ['or_number', 'amount_paid'],
};

export interface ExtractedReceiptData {
  or_number?: string;
  student_id?: string;
  student_name?: string;
  amount_paid?: number;
  payment_date?: string;
  school_name?: string;
  payment_mode?: string;
  check_number_reference?: string;
  remarks?: string;
}
