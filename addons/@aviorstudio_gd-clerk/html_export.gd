class_name GdClerkHtmlExport
extends RefCounted

const BRIDGE_SCRIPT := '<script src="gd-clerk/gd_clerk_bridge.js"></script>'

static func patch_html(html: String) -> String:
	if html.contains("gd-clerk/gd_clerk_bridge.js"):
		return html
	# The vendored browser bundle auto-boots when parsed. Do not inject it here.
	# The bridge inserts that same-origin file only after configure validates the
	# project-supplied publishable key.
	var injection := BRIDGE_SCRIPT + "\n"
	var head := html.find("</head>")
	if head >= 0:
		return html.substr(0, head) + injection + html.substr(head)
	return injection + html
