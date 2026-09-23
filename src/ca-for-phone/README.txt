# 把手机要安装的 CA 证书放这里（dsh-ca.cer / dsh-ca.crt）
CA 证书由服务器上的 issue-ca-and-server-cert.sh 生成，用于消除 HTTPS 证书警告。
注意：CA 证书是公开信息（可安全分发）；CA 私钥才是机密，它只留在服务器上。
