const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');

let client;

function getSesClient() {
  if (!client) {
    client = new SESv2Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
  }
  return client;
}

async function sendEmail({ to, subject, html, text }) {
  const fromAddress = process.env.SES_FROM_EMAIL;
  if (!fromAddress) {
    console.error('SES_FROM_EMAIL이 설정되지 않아 메일을 보낼 수 없습니다.');
    return;
  }
  return getSesClient().send(new SendEmailCommand({
    FromEmailAddress: fromAddress,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: { Data: text || html.replace(/<[^>]+>/g, ''), Charset: 'UTF-8' }
        }
      }
    }
  }));
}

module.exports = { sendEmail };
