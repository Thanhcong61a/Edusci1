import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';
const page = await readFile(join(root, 'public', 'index.html'));

const SYSTEM_INSTRUCTIONS = `Bạn là EduSci AI – người bạn đồng hành học tập Khoa học Tự nhiên của học sinh Việt Nam. Mục tiêu: giải thích khoa học rõ ràng, chính xác, giúp học sinh hiểu bản chất và biết tự suy luận.

PHẠM VI:
- Vật lí: chuyển động, lực, áp suất, năng lượng, nhiệt, ánh sáng, âm thanh, điện, từ, các hiện tượng tự nhiên, bài tập và đơn vị SI.
- Hóa học: nguyên tử, phân tử, chất, dung dịch, phản ứng, phương trình hóa học, mol, nồng độ, tính toán hóa học, kiến thức thực hành an toàn.
- Sinh học: tế bào, cơ thể, vi sinh vật, quang hợp, hô hấp, trao đổi chất, sinh sản, di truyền, tiến hóa, hệ sinh thái, môi trường.
- Ưu tiên chương trình KHTN lớp 6–9; hỗ trợ THPT khi được yêu cầu.

PHƯƠNG PHÁP TRẢ LỜI:
1) Trả lời bằng tiếng Việt tự nhiên, thân thiện, phù hợp học sinh. Dựa trên môn học và lớp học được truyền vào, không tự nhận đã đọc SGK cụ thể nếu chưa được cung cấp.
2) Bắt đầu từ ý chính, rồi giải thích bằng ví dụ gần gũi. Với bài tập: tóm tắt dữ kiện, xác định yêu cầu, công thức/phương trình, giải từng bước, ghi đơn vị và kiểm tra kết quả. Nếu học sinh muốn gợi ý trước, không đưa đáp án ngay.
3) Với Hóa học: kiểm tra hóa trị, bảo toàn nguyên tố, cân bằng phương trình và điều kiện phản ứng. Với Vật lí: ký hiệu, đơn vị SI, phép biến đổi và tính hợp lí. Với Sinh học: phân biệt khái niệm dễ nhầm lẫn, nêu đúng cấp độ tổ chức.
4) Nếu câu hỏi mơ hồ, hỏi thêm thông tin cần thiết; nếu không chắc, nói rõ, không bịa dẫn chứng hoặc nguồn. Khi có thể, kết thúc bằng 1 câu hỏi ngắn để học sinh tự kiểm tra hiểu bài.
5) Trả lời thường 120–250 từ, nhưng giải chi tiết hơn nếu được yêu cầu. Có thể trình bày toán bằng văn bản đơn giản để hiển thị tốt trong hộp chat.
6) Nếu được hỏi về thí nghiệm, ưu tiên thí nghiệm an toàn, có giám sát phù hợp. Không chỉ dẫn pha trộn hóa chất độc, chế tạo chất nổ, điện lưới, lửa hoặc thao tác nguy hiểm tại nhà.
7) Không yêu cầu tên thật, địa chỉ, số điện thoại, trường học hoặc dữ liệu nhận dạng cá nhân của học sinh. Không chẩn đoán y khoa. Khi gặp câu hỏi ngoài phạm vi, vẫn giúp ngắn gọn và đề nghị quay lại KHTN.

Đây là trợ lý AI dựa trên kiến thức chung của mô hình, KHÔNG phải công cụ tra cứu SGK chính thức. Không ngụ ý có dữ liệu sách giáo khoa được kết nối nếu chưa được cung cấp.`;

const rate = new Map();
function limited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60_000;
  const item = rate.get(ip);
  if (!item || item.reset < now) {
    rate.set(ip, { count: 1, reset: now + windowMs });
    return false;
  }
  item.count++;
  return item.count > 30;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rate) if (entry.reset < now) rate.delete(ip);
}, 60_000).unref();

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(page);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, configured: Boolean(API_KEY) });
  }

  if (req.method !== 'POST' || url.pathname !== '/api/chat') {
    return json(res, 404, { error: 'Không tìm thấy trang.' });
  }

  // Only same-origin requests from the website are intended.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    return json(res, 403, { error: 'Yêu cầu không hợp lệ.' });
  }

  if (!API_KEY) {
    return json(res, 503, { error: 'Chưa cấu hình OPENAI_API_KEY trên máy chủ.' });
  }

  if (limited(req.socket.remoteAddress || 'unknown')) {
    return json(res, 429, { error: 'Bạn đã gửi nhiều câu hỏi. Vui lòng thử lại sau ít phút.' });
  }

  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) {
    return json(res, 415, { error: 'Dữ liệu phải ở định dạng JSON.' });
  }

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_000) {
      return json(res, 413, { error: 'Nội dung quá dài.' });
    }
  }

  let input;
  try { input = JSON.parse(raw); }
  catch { return json(res, 400, { error: 'Dữ liệu không hợp lệ.' }); }

  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > 1500) {
    return json(res, 400, { error: 'Vui lòng nhập câu hỏi từ 1–1500 ký tự.' });
  }

  const permittedGrades = new Set(['6','7','8','9','THPT','Chưa chọn']);
  const permittedSubjects = new Set(['Tổng hợp','Vật lí','Hóa học','Sinh học']);
  const grade = permittedGrades.has(input.grade) ? input.grade : 'Chưa chọn';
  const subject = permittedSubjects.has(input.subject) ? input.subject : 'Tổng hợp';

  const history = Array.isArray(input.history) ? input.history.slice(-10) : [];
  const safeHistory = history
    .filter(item => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map(item => ({ role: item.role, content: item.content.slice(0, 1500) }));

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        reasoning: { effort: 'low' },
        instructions: SYSTEM_INSTRUCTIONS + `\n\nLựa chọn hiện tại của học sinh: lớp ${grade}; lĩnh vực ${subject}.`,
        input: [...safeHistory, { role: 'user', content: message }],
        max_output_tokens: 900,
        store: false,
      }),
      signal: AbortSignal.timeout(40_000),
    });
    const result = await upstream.json();
    if (!upstream.ok) {
      console.error('OpenAI status:', upstream.status, result?.error?.code || 'unknown');
      return json(res, 502, { error: 'Không kết nối được AI. Kiểm tra API key, hạn mức và model.' });
    }
    const answer = (result.output_text || result.output?.flatMap(item => item.content || [])
      .filter(item => item.type === 'output_text').map(item => item.text).join('\n') || '').trim();
    if (!answer) return json(res, 502, { error: 'AI chưa trả lời. Bạn hãy thử lại.' });
    return json(res, 200, { answer });
  } catch (error) {
    console.error('OpenAI request:', error?.name || 'error');
    return json(res, 502, { error: 'Kết nối chậm hoặc tạm thời gián đoạn. Hãy thử lại.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EduSci AI listening on http://localhost:${PORT}`);
});
