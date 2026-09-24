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
	DirAccess.make_dir_recursive_absolute(out_dir)
	_copy_clerk_files(out_dir)
	_copy_file("res://addons/@aviorstudio_gd-clerk/javascript/gd_clerk_bridge.js", out_dir.path_join("gd_clerk_bridge.js"))
	var html := FileAccess.get_file_as_string(html_path)
	if html.is_empty():
		return
	var patched := GdClerkHtmlExport.patch_html(html)
	var out := FileAccess.open(html_path, FileAccess.WRITE)
	if out == null:
		return
	out.store_string(patched)
	out.close()

func _copy_clerk_files(out_dir: String) -> void:
	var source := "res://addons/@aviorstudio_gd-clerk/javascript/clerk"
	var dir := DirAccess.open(source)
	if dir == null:
		return
	dir.list_dir_begin()
	var name := dir.get_next()
	while name != "":
		if not dir.current_is_dir() and name.ends_with(".js"):
			_copy_file(source.path_join(name), out_dir.path_join(name))
		name = dir.get_next()
	dir.list_dir_end()

func _copy_file(source: String, target: String) -> void:
	var bytes := FileAccess.get_file_as_bytes(source)
	var out := FileAccess.open(target, FileAccess.WRITE)
	if out == null:
		return
	out.store_buffer(bytes)
	out.close()
