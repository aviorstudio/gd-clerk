extends EditorExportPlugin

var _html_path := ""
var _is_web := false

func _get_name() -> String:
	return "GdClerkWebExport"

func _export_begin(features: PackedStringArray, is_debug: bool, path: String, flags: int) -> void:
	_is_web = features.has("web")
	_html_path = path

func _export_end() -> void:
	if not _is_web or _html_path.is_empty():
		return
	var html_path := _html_path
	if not html_path.ends_with(".html"):
		return
	var out_dir := html_path.get_base_dir().path_join("gd-clerk")
	if DirAccess.make_dir_recursive_absolute(out_dir) != OK:
		push_error("gd-clerk: cannot create exported asset directory.")
		return
	if not _copy_clerk_files(out_dir):
		return
	if not _copy_file("res://addons/@aviorstudio_gd-clerk/javascript/gd_clerk_bridge.js", out_dir.path_join("gd_clerk_bridge.js")):
		return
	var html := FileAccess.get_file_as_string(html_path)
	if html.is_empty():
		push_error("gd-clerk: exported HTML could not be read.")
		return
	var patched := GdClerkHtmlExport.patch_html(html)
	var out := FileAccess.open(html_path, FileAccess.WRITE)
	if out == null:
		push_error("gd-clerk: exported file could not be written.")
		return
	out.store_string(patched)
	if out.get_error() != OK:
		push_error("gd-clerk: exported HTML write failed.")
	out.close()

func _copy_clerk_files(out_dir: String) -> bool:
	var source := "res://addons/@aviorstudio_gd-clerk/javascript/clerk"
	var dir := DirAccess.open(source)
	if dir == null:
		push_error("gd-clerk: bundled Clerk assets could not be opened.")
		return false
	if dir.list_dir_begin() != OK:
		push_error("gd-clerk: bundled Clerk assets could not be listed.")
		return false
	var name := dir.get_next()
	while name != "":
		if not dir.current_is_dir() and name.ends_with(".js"):
			if not _copy_file(source.path_join(name), out_dir.path_join(name)):
				dir.list_dir_end()
				return false
		name = dir.get_next()
	dir.list_dir_end()
	return true

func _copy_file(source: String, target: String) -> bool:
	var bytes := FileAccess.get_file_as_bytes(source)
	if bytes.is_empty():
		push_error("gd-clerk: bundled asset could not be read.")
		return false
	var out := FileAccess.open(target, FileAccess.WRITE)
	if out == null:
		push_error("gd-clerk: exported asset could not be written.")
		return false
	out.store_buffer(bytes)
	var error := out.get_error()
	out.close()
	if error != OK:
		push_error("gd-clerk: exported asset write failed.")
		return false
	return true
