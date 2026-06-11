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

		let userRow = {};
		if (account) {
			userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
		}

		if (account && userRow.email !== env.admin) {
			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);
			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}
			if (roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}
		}

		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to) }];
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

		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			await telegramService.sendEmailToBot({ env }, emailRow);
		}

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
		
		// ======= MATRIX 转发模块 =======
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
				
				let bodyStr = email.text || '';
				if (!bodyStr && email.html) {
					bodyStr = email.html.substring(0, 1000).replace(/<[^>]*>/g, '');
				}
				if (bodyStr.length > 500) {
					bodyStr = bodyStr.substring(0, 500) + '\n\n... (正文过长已截断)';
				}

				let htmlStr = email.html || '';
				if (htmlStr) {
					if (htmlStr.length > 25000) {
						htmlStr = htmlStr.substring(0, 25000) + '<br><br><b>... [邮件体积过大，HTML 已自动截断安全保护]</b>';
					}

					if (attachments.length > 0 && r2Domain) {
						const protocol = r2Domain.startsWith('http') ? '' : 'https://';
						const baseUrl = `${protocol}${r2Domain}`;
						attachments.forEach(att => {
							if (att.contentId) {
								const cleanCid = att.contentId.replace(/[<>]/g, '');
								const r2Url = `${baseUrl}/${att.key}`;
								htmlStr = htmlStr.split(`cid:${cleanCid}`).join(r2Url);
							}
						});
					}
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

				const response = await fetch(matrixUrl, {
					method: "POST",
					headers: {
						"Authorization": `Bearer ${env.MATRIX_TOKEN}`, 
						"Content-Type": "application/json"
					},
					body: JSON.stringify(payload)
				});

				if (!response.ok) {
					const errorText = await response.text();
					console.error(`Matrix API 响应错误 [${response.status}]: ${errorText}`);
				}
			} catch (e) {
				console.error('Matrix 转发模块异常: ', e);
			}
		}

	} catch (e) { 
		console.error('邮件接收异常: ', e);
		throw e;
	}
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {
	const blackFromList = blackFromStr ? blackFromStr.split(',') : [];
	const blackContentList = blackContentStr ? blackContentStr.split(',') : [];
	const blackSubjectList = blackSubjectStr ? blackSubjectStr.split(',') : [];

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true;
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true;
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true;
		}
	}
	return false;
}
