// Renders report data into the email template.
import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';

let compiled;
export function render(data) {
  compiled ||= Handlebars.compile(fs.readFileSync(
    path.join(process.cwd(), 'email', 'bg-uptime-report.hbs.html'), 'utf8'));
  return compiled(data);
}
