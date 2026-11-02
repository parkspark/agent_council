// --mock 실행용 연습 프로젝트(.sandbox/demo-project)를 만들어 둡니다.
// 실제 프로젝트를 건드리지 않고 실행·리뷰·경쟁 모드를 시험할 수 있습니다.

import fs from 'node:fs';
import path from 'node:path';
import { git, gitAvailable } from './git.js';

const DEMO_FILE = '# Council 데모\n\n가짜 에이전트들이 이 파일을 수정합니다.\n';

export async function ensureDemoProject(root) {
  const dir = path.join(root, '.sandbox', 'demo-project');
  const fresh = !fs.existsSync(dir);
  if (fresh) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), '# 데모 프로젝트\n\n--mock 모드에서 쓰는 연습용 저장소입니다.\n');
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), "export function greet(name) {\n  return `안녕하세요, ${name}님`;\n}\n");
  }
  fs.writeFileSync(path.join(dir, 'council-demo.md'), DEMO_FILE); // 매번 처음 상태로
  if (fresh && (await gitAvailable())) {
    await git(['init', '-q'], dir);
    await git(['add', '-A'], dir);
    await git(['-c', 'user.name=Agent Council', '-c', 'user.email=council@localhost', 'commit', '-q', '-m', 'demo: initial'], dir);
  }
  return dir;
}
