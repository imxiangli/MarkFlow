// Unit tests for guessing a new document's type from its text (pure, runs in Node):  npm run test:type
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectContentType } from '../src/renderer/src/editor/contentType.ts'

const cases: [string, string | null, string][] = [
  ['SQL', 'SQL', 'SELECT id, name\nFROM users\nWHERE age > 18\nORDER BY name;'],
  ['SQL', 'lower-case SQL', 'select * from orders where id = 1;'],
  ['SQL', 'DDL', 'CREATE TABLE users (\n  id INT NOT NULL AUTO_INCREMENT,\n  name VARCHAR(64),\n  PRIMARY KEY (id)\n) ENGINE=InnoDB;'],
  ['SQL', 'commented SQL', '-- daily report\ninsert into stats (day, n) values (current_date, 3);\nupdate stats set n = n + 1 where day = current_date;'],
  ['JSON', 'JSON object', '{\n  "name": "markflow",\n  "version": "1.0.0"\n}'],
  ['JSON', 'JSON array', '[{"a": 1}, {"a": 2}]'],
  ['HTML', 'HTML page', '<!DOCTYPE html>\n<html>\n<body><p>Hi</p></body>\n</html>'],
  ['HTML', 'HTML fragment', '<div class="card">\n  <span>Title</span>\n</div>'],
  ['XML', 'XML', '<?xml version="1.0"?>\n<project><name>x</name></project>'],
  ['XML', 'XML without declaration', '<project>\n  <groupId>com.example</groupId>\n</project>'],
  ['Python', 'Python', 'import os\n\ndef main():\n    print(os.getcwd())\n\nif __name__ == "__main__":\n    main()'],
  ['JavaScript', 'JavaScript', "const fs = require('fs')\nfunction read(p) {\n  return fs.readFileSync(p, 'utf8')\n}\nconsole.log(read('a'))"],
  ['TypeScript', 'TypeScript', "interface User {\n  id: number\n  name: string\n}\nexport const users: User[] = []"],
  ['Java', 'Java', 'package com.example;\n\nimport java.util.List;\n\npublic class App {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}'],
  ['Go', 'Go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}'],
  ['Rust', 'Rust', 'fn main() {\n    let mut v = vec![1, 2];\n    println!("{:?}", v);\n}'],
  ['C++', 'C++', '#include <iostream>\nint main() {\n  std::cout << "hi" << std::endl;\n}'],
  ['Shell', 'shebang', '#!/bin/bash\necho hi'],
  ['Shell', 'shell commands', 'sudo apt-get update\nnpm install\ngit clone https://example.com/x.git\ncd x && make'],
  ['CSS', 'CSS', '.card {\n  color: red;\n  padding: 4px 8px;\n}\n@media (max-width: 600px) {\n  .card { display: none; }\n}'],
  ['YAML', 'YAML', 'name: build\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest'],
  ['Dockerfile', 'Dockerfile', 'FROM node:20\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "index.js"]'],
  ['PHP', 'PHP', '<?php\necho "hi";'],
  // Prose and Markdown stay Markdown (null).
  ['', 'empty', ''],
  ['', 'prose', 'Select the file from the list, then update the settings to whatever you like.'],
  ['', 'Chinese prose', '今天的会议讨论了下季度的计划，select 和 from 只是普通单词。'],
  ['', 'Markdown', '# Title\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two'],
  ['', 'Markdown with a SQL code block', '# Query\n\n```sql\nSELECT * FROM users;\n```'],
  ['', 'half-typed JSON', '{'],
  ['', 'a single const', 'const x = 1'],
  ['', 'prose with a git mention', 'git is a version control system.\nIt tracks changes.']
]

for (const [expected, label, text] of cases) {
  test(`${label} → ${expected || 'Markdown'}`, () => {
    assert.equal(detectContentType(text), expected || null)
  })
}
