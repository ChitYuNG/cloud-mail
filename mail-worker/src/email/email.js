import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}

		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);


		const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockFlag) {
			message.setReject('Message rejected');
			return;
		}

		const account = await accountService.selectByEmailIncludeDel({ env: env }, message.to);

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		let userRow = {}

		if (account) {
			 userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';
		const code = await aiService.extractCode({ env }, email, { aiCode, aiCodeFilter });

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			code,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		try {
			if (attachments.length > 0) {
				await attService.addAtt({ env }, attachments);
			}
		} catch (e) {
			console.error(e);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		//转发到TG
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow)
		}

		//转发到其他邮箱
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			await Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

		}
		
		// ======= MATRIX 转发模块 (高性能、轻量化、防 CPU 熔断版本) =======
		const allowedEmailsStr = env.MATRIX_ALLOWED_EMAILS || "";
		const matrixAllowedEmails = allowedEmailsStr
			.split(',')
			.map(email => email.trim())
			.filter(email => email.length > 0);

		if (matrixAllowedEmails.includes(message.to)) {
			try {
				const roomId = env.MATRIX_ROOM_ID;
				const matrixDomain = env.MATRIX_DOMAIN || 'chat.samlam.org'; 

				if (!roomId) {
					console.error('Matrix 转发失败：未配置 MATRIX_ROOM_ID 环境变量');
					return;
				}

				const fromAddress = email.from?.address || '未知地址';
				const fromName = email.from?.name ? `${email.from.name} ` : '';
				const subjectStr = email.subject || '无主题';
				
				// 1. 纯文本生成（拒绝大正则）
				let bodyStr = email.text || '';
				if (!bodyStr && email.html) {
					// 仅作长度切片，杜绝大文本下的正则清洗
					bodyStr = email.html.substring(0, 1000).replace(/<[^>]*>/g, '');
				}
				if (bodyStr.length > 500) {
					bodyStr = bodyStr.substring(0, 500) + '\n\n... (正文过长已截断)';
				}

				// 2. 超低能耗 HTML 处理
				let htmlStr = email.html || '';
				if (htmlStr) {
					// 【CPU 优化核心 1】如果 HTML 字符串里包含巨大的 base64 图片数据，
					// 绝对不要用正则去匹配它。直接通过严格的硬截断限制大小，瞬间释放 CPU 压力。
					if (htmlStr.length > 25000) {
						htmlStr = htmlStr.substring(0, 25000) + '<br><br><b>... [邮件体积过大，HTML 已自动截断安全保护]</b>';
					}

					// 【CPU 优化核心 2】只有在截断后的安全长度内，才执行轻量级替换
					if (attachments.length > 0 && r2Domain) {
						const protocol = r2Domain.startsWith('http') ? '' : 'https://';
						const baseUrl = `${protocol}${r2Domain}`;
						
						attachments.forEach(att => {
							if (att.contentId) {
								const cleanCid = att.contentId.replace(/[<>]/g, '');
								const r2Url = `${baseUrl}/${att.key}`;
								// 使用原生内建的高效 split 方案，放弃正则
								htmlStr = htmlStr.split(`cid:${cleanCid}`).join(r2Url);
							}
						});
					}

					// 清理不必要的包装
					htmlStr = htmlStr.replace(/<html[^>]*>|<head[^>]*>|[\s\S]*<\/head>|<\/html>/gi, '').trim();
				} else {
					htmlStr = bodyStr.replace(/\n/g, '<br>');
				}

				const matrixUrl = `https://${matrixDomain}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message`;

				const payload = {
					msgtype: "m.text",
					body: `📧 [${message.to}] 新邮件到达\n发件人: ${fromName}<${fromAddress}>\n主题: ${subjectStr}\n\n${bodyStr}`,
					format: "org.matrix.custom.html",
					formatted_body: `<h3>📧 [${message.to}] 新邮件到达</h3><b>发件人:</b> ${fromName}&lt;${fromAddress}&gt;<br><b>主题:</b> ${subjectStr}<br><br>${htmlStr}`
				};

				const response = await fetch(matrix
