import {
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileDigit,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  type LucideProps
} from 'lucide-react'
import { fileCategory, type FileCategory } from '@/lib/fileTypes'

const ICONS: Record<FileCategory, React.ComponentType<LucideProps>> = {
  markdown: FileText,
  image: FileImage,
  code: FileCode,
  json: FileJson,
  shell: FileTerminal,
  spreadsheet: FileSpreadsheet,
  text: FileText,
  archive: FileArchive,
  executable: FileCog,
  document: FileText,
  audio: FileAudio,
  video: FileVideo,
  font: FileType,
  database: Database,
  data: FileDigit
}

/** Icon for a file, chosen from its name (extension, well-known names). */
export function FileIcon({ name, ...props }: { name: string } & LucideProps) {
  const Icon = ICONS[fileCategory(name)] ?? File
  return <Icon {...props} />
}
